package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

// ProfileRecord is the on-disk SSH profile. Secret material is stored only as
// ciphertext produced by SecretBox; the record never holds a plaintext password
// or private key.
type ProfileRecord struct {
	ID              string `json:"id"`
	Name            string `json:"name"`
	Group           string `json:"group"`
	Host            string `json:"host"`
	Port            int    `json:"port"`
	User            string `json:"user"`
	AuthKind        string `json:"authKind"`
	PasswordCipher  string `json:"passwordCipher,omitempty"`
	KeyCipher       string `json:"keyCipher,omitempty"`
	Mock            bool   `json:"mock"`
	Color           string `json:"color,omitempty"`
	Description     string `json:"description,omitempty"`
	CreatedAt       string `json:"createdAt"`
	UpdatedAt       string `json:"updatedAt"`
	LastConnectedAt string `json:"lastConnectedAt,omitempty"`
}

type KnownHostRecord struct {
	ID          string `json:"id"`
	Host        string `json:"host"`
	Port        int    `json:"port"`
	KeyType     string `json:"keyType"`
	Fingerprint string `json:"fingerprint"`
	AddedAt     string `json:"addedAt"`
	Mock        bool   `json:"mock"`
}

type stateFile struct {
	Version    int               `json:"version"`
	Profiles   []ProfileRecord   `json:"profiles"`
	KnownHosts []KnownHostRecord `json:"knownHosts"`
	UpdatedAt  string            `json:"updatedAt"`
}

// Store is a small JSON document store with atomic writes. A single daemon
// process owns the file; the mutex serialises readers and writers in-process.
type Store struct {
	path  string
	mu    sync.RWMutex
	state stateFile
}

func OpenStore(path string) (*Store, error) {
	s := &Store{path: path}
	if err := s.load(); err != nil {
		return nil, err
	}
	return s, nil
}

func (s *Store) Kind() string { return "json-file" }

func (s *Store) Path() string { return s.path }

func (s *Store) load() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	raw, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		s.state = stateFile{Version: 1}
		return nil
	}
	if err != nil {
		return fmt.Errorf("read state: %w", err)
	}
	if err := json.Unmarshal(raw, &s.state); err != nil {
		return fmt.Errorf("parse state: %w", err)
	}
	if s.state.Version == 0 {
		s.state.Version = 1
	}
	return nil
}

func (s *Store) persistLocked() error {
	s.state.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	payload, err := json.MarshalIndent(s.state, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(s.path), ".state-*.json")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() { _ = os.Remove(tmpName) }()
	if err := tmp.Chmod(0o600); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(payload); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, s.path)
}

func (s *Store) Profiles() []ProfileRecord {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]ProfileRecord, len(s.state.Profiles))
	copy(out, s.state.Profiles)
	sort.SliceStable(out, func(i, j int) bool {
		if out[i].Group != out[j].Group {
			return out[i].Group < out[j].Group
		}
		return out[i].Name < out[j].Name
	})
	return out
}

func (s *Store) Profile(id string) (ProfileRecord, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, p := range s.state.Profiles {
		if p.ID == id {
			return p, true
		}
	}
	return ProfileRecord{}, false
}

func (s *Store) UpsertProfile(rec ProfileRecord) (ProfileRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UTC().Format(time.RFC3339)
	rec.UpdatedAt = now
	if rec.CreatedAt == "" {
		rec.CreatedAt = now
	}
	replaced := false
	for i := range s.state.Profiles {
		if s.state.Profiles[i].ID == rec.ID {
			rec.CreatedAt = s.state.Profiles[i].CreatedAt
			s.state.Profiles[i] = rec
			replaced = true
			break
		}
	}
	if !replaced {
		s.state.Profiles = append(s.state.Profiles, rec)
	}
	return rec, s.persistLocked()
}

func (s *Store) DeleteProfile(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.state.Profiles {
		if s.state.Profiles[i].ID == id {
			s.state.Profiles = append(s.state.Profiles[:i], s.state.Profiles[i+1:]...)
			return s.persistLocked()
		}
	}
	return os.ErrNotExist
}

func (s *Store) KnownHosts() []KnownHostRecord {
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]KnownHostRecord, len(s.state.KnownHosts))
	copy(out, s.state.KnownHosts)
	return out
}

func (s *Store) KnownHost(id string) (KnownHostRecord, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	for _, kh := range s.state.KnownHosts {
		if kh.ID == id {
			return kh, true
		}
	}
	return KnownHostRecord{}, false
}

func (s *Store) UpsertKnownHost(rec KnownHostRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.state.KnownHosts {
		if s.state.KnownHosts[i].ID == rec.ID {
			s.state.KnownHosts[i] = rec
			return s.persistLocked()
		}
	}
	s.state.KnownHosts = append(s.state.KnownHosts, rec)
	return s.persistLocked()
}

func (s *Store) DeleteKnownHost(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.state.KnownHosts {
		if s.state.KnownHosts[i].ID == id {
			s.state.KnownHosts = append(s.state.KnownHosts[:i], s.state.KnownHosts[i+1:]...)
			return s.persistLocked()
		}
	}
	return os.ErrNotExist
}

func (s *Store) Close() error { return nil }

// MarkConnected records the last successful connection time for a profile.
func (s *Store) MarkConnected(id string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for i := range s.state.Profiles {
		if s.state.Profiles[i].ID == id {
			s.state.Profiles[i].LastConnectedAt = time.Now().UTC().Format(time.RFC3339)
			return s.persistLocked()
		}
	}
	return os.ErrNotExist
}
