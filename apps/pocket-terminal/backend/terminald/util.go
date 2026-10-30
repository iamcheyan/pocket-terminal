package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"
)

// newID produces a short, sortable, URL-safe identifier. Time prefix makes
// daemon logs readable; the random suffix prevents collisions between tabs.
func newID(prefix string) string {
	buf := make([]byte, 8)
	_, _ = rand.Read(buf)
	return fmt.Sprintf("%s%s_%s", prefix, strconv.FormatInt(time.Now().UnixMilli(), 36), hex.EncodeToString(buf)[:8])
}

func itoa(v int) string { return strconv.Itoa(v) }

func clamp(v, lo, hi int) int {
	if v < lo {
		return lo
	}
	if v > hi {
		return hi
	}
	return v
}

// sshFingerprint renders the SHA256 fingerprint of a host key in the OpenSSH
// `SHA256:<base64-no-padding>` form.
func sshFingerprint(keyBytes []byte) string {
	sum := sha256.Sum256(keyBytes)
	return "SHA256:" + base64.RawStdEncoding.EncodeToString(sum[:])
}

// hashID returns a stable, short identifier for log dedupe.
func hashID(seed string) string {
	sum := sha256.Sum256([]byte(seed))
	return hex.EncodeToString(sum[:8])
}

// hostID is the stable key for a known-host entry. net.JoinHostPort keeps IPv6
// literals unambiguous.
func hostID(host string, port int) string {
	return net.JoinHostPort(strings.ToLower(strings.TrimSpace(host)), strconv.Itoa(port))
}

// clampInt parses an integer query value and clamps it into [lo, hi].
func clampInt(raw string, fallback, lo, hi int) int {
	value, err := strconv.Atoi(raw)
	if err != nil {
		return fallback
	}
	return clamp(value, lo, hi)
}
