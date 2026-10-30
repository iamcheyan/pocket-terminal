package main

import (
	"net"
	"os"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/agent"
)

// osGetenv is a seam so tests can control agent discovery.
func osGetenv(key string) string { return os.Getenv(key) }

// sshAgentSigners returns the keyring-backed signers from SSH_AUTH_SOCK. The
// private key never enters terminald's own storage in this path.
func sshAgentSigners(socket string) ([]ssh.Signer, error) {
	conn, err := net.Dial("unix", socket)
	if err != nil {
		return nil, err
	}
	client := agent.NewClient(conn)
	return client.Signers()
}
