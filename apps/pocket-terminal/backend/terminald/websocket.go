package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// wsControl is the JSON control channel multiplexed over the session socket.
// Binary frames carry raw PTY bytes in both directions.
type wsControl struct {
	Type  string `json:"type"`
	Cols  uint16 `json:"cols,omitempty"`
	Rows  uint16 `json:"rows,omitempty"`
	Data  string `json:"data,omitempty"`
	Error string `json:"error,omitempty"`
	State string `json:"state,omitempty"`
}

type wsWriter struct {
	mu   sync.Mutex
	conn *websocket.Conn
}

func (w *wsWriter) binary(ctx context.Context, payload []byte) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.conn.Write(ctx, websocket.MessageBinary, payload)
}

func (w *wsWriter) control(ctx context.Context, payload any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.conn.Write(ctx, websocket.MessageText, raw)
}

// serveSessionWebsocket attaches one viewer to a session. Multiple viewers may
// attach concurrently; input from all of them is forwarded, output is fanned
// out from the shared scrollback cursor.
func (s *server) serveSessionWebsocket(w http.ResponseWriter, r *http.Request, session *Session) {
	originPatterns := append([]string{
		"localhost:*", "127.0.0.1:*", "[::1]:*",
	}, s.cfg.allowedOrigins...)
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		OriginPatterns:  originPatterns,
		CompressionMode: websocket.CompressionDisabled,
	})
	if err != nil {
		// Accept already wrote an HTTP error response.
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(1 << 20)

	ctx := r.Context()
	writer := &wsWriter{conn: conn}

	offset := parseOffset(r.URL.Query().Get("offset"))
	if data, next := session.Output(offset); len(data) > 0 {
		if err := writer.binary(ctx, data); err != nil {
			return
		}
		offset = next
	}
	if err := writer.control(ctx, wsControl{Type: "ready", State: string(sessionRunning)}); err != nil {
		return
	}

	poke, unsubscribe := session.subscribe()
	defer unsubscribe()

	errCh := make(chan error, 2)
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	// Reader: keystrokes and control messages.
	go func() {
		for {
			typ, payload, err := conn.Read(ctx)
			if err != nil {
				errCh <- err
				return
			}
			switch typ {
			case websocket.MessageBinary:
				if err := session.WriteInput(payload); err != nil {
					errCh <- err
					return
				}
			case websocket.MessageText:
				var msg wsControl
				if err := json.Unmarshal(payload, &msg); err != nil {
					continue
				}
				switch msg.Type {
				case "input":
					if err := session.WriteInput([]byte(msg.Data)); err != nil {
						errCh <- err
						return
					}
				case "resize":
					_ = session.Resize(msg.Cols, msg.Rows)
				case "ping":
					if err := writer.control(ctx, wsControl{Type: "pong"}); err != nil {
						errCh <- err
						return
					}
				}
			}
		}
	}()

	// Writer: stream scrollback deltas, report exit and keep the link warm.
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case err := <-errCh:
			if err != nil && !errors.Is(err, context.Canceled) && websocket.CloseStatus(err) == -1 {
				s.logger.Printf("session %s websocket closed: %v", session.ID, err)
			}
			return
		case <-poke:
			if data, next := session.Output(offset); len(data) > 0 {
				if err := writer.binary(ctx, data); err != nil {
					return
				}
				offset = next
			}
			if dto := session.DTO(); dto.State != sessionRunning {
				_ = writer.control(ctx, wsControl{Type: "exit", State: string(dto.State), Data: exitMessage(dto)})
				if data, next := session.Output(offset); len(data) > 0 {
					_ = writer.binary(ctx, data)
					offset = next
				}
				_ = conn.Close(websocket.StatusNormalClosure, "session exited")
				return
			}
		case <-ticker.C:
			if err := writer.control(ctx, wsControl{Type: "tick"}); err != nil {
				return
			}
			if data, next := session.Output(offset); len(data) > 0 {
				if err := writer.binary(ctx, data); err != nil {
					return
				}
				offset = next
			}
			if dto := session.DTO(); dto.State != sessionRunning {
				_ = writer.control(ctx, wsControl{Type: "exit", State: string(dto.State), Data: exitMessage(dto)})
				_ = conn.Close(websocket.StatusNormalClosure, "session exited")
				return
			}
		}
	}
}

func exitMessage(dto SessionDTO) string {
	code := 0
	if dto.ExitCode != nil {
		code = *dto.ExitCode
	}
	var b strings.Builder
	b.WriteString("process exited with code ")
	b.WriteString(itoa(code))
	return b.String()
}
