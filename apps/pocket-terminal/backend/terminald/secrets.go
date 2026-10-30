package main

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// SecretBox encrypts SSH credentials at rest. Phase 1 uses an AES-256-GCM key
// generated on first start and stored with 0600 permissions next to the state
// file. `secret-tool`-backed keyrings are listed as the integration point for a
// future keyring provider; this build never writes plaintext credentials.
type SecretBox struct {
	keyPath string
	aead    cipher.AEAD
}

const secretKeyFile = "secret.key"

func OpenSecretBox(dataDir string) (*SecretBox, error) {
	box := &SecretBox{keyPath: filepath.Join(dataDir, secretKeyFile)}
	key, err := os.ReadFile(box.keyPath)
	if errors.Is(err, os.ErrNotExist) {
		key = make([]byte, 32)
		if _, err := io.ReadFull(rand.Reader, key); err != nil {
			return nil, fmt.Errorf("generate secret key: %w", err)
		}
		if err := os.WriteFile(box.keyPath, key, 0o600); err != nil {
			return nil, fmt.Errorf("write secret key: %w", err)
		}
	} else if err != nil {
		return nil, fmt.Errorf("read secret key: %w", err)
	}
	if len(key) != 32 {
		return nil, fmt.Errorf("secret key has unexpected length %d", len(key))
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	box.aead = aead
	return box, nil
}

// Seal returns a base64 nonce+ciphertext blob bound to the supplied context
// string (profile id + field), so a ciphertext cannot be replayed on another
// profile.
func (b *SecretBox) Seal(plaintext, context string) (string, error) {
	if strings.TrimSpace(plaintext) == "" {
		return "", nil
	}
	nonce := make([]byte, b.aead.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", err
	}
	sealed := b.aead.Seal(nonce, nonce, []byte(plaintext), []byte(context))
	return base64.StdEncoding.EncodeToString(sealed), nil
}

func (b *SecretBox) Open(encoded, context string) (string, error) {
	if encoded == "" {
		return "", nil
	}
	raw, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		return "", fmt.Errorf("decode secret: %w", err)
	}
	nonceSize := b.aead.NonceSize()
	if len(raw) < nonceSize {
		return "", errors.New("secret payload truncated")
	}
	nonce, body := raw[:nonceSize], raw[nonceSize:]
	plain, err := b.aead.Open(nil, nonce, body, []byte(context))
	if err != nil {
		return "", errors.New("secret decryption failed")
	}
	return string(plain), nil
}

func (b *SecretBox) Describe() map[string]any {
	return map[string]any{
		"provider":         "aes-256-gcm-file",
		"keyFile":          filepath.Base(b.keyPath),
		"keyMode":          "0600",
		"keyring":          false,
		"keyringNote":      "system keyring (secret-tool) provider is a documented follow-up; file key is never logged or returned",
		"plaintextSecrets": false,
	}
}
