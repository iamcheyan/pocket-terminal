.PHONY: build test dev backend ui-smoke screenshots verify clean

BACKEND := apps/pocket-terminal/backend/terminald
FRONTEND := apps/pocket-terminal/frontend
ADDR ?= 127.0.0.1:8795

build:
	cd $(BACKEND) && go build -o terminald .
	cd $(FRONTEND) && npm run build

test:
	cd $(BACKEND) && go vet ./... && go test ./...
	cd $(FRONTEND) && npx tsc -b && npx vitest run

backend:
	cd $(BACKEND) && POCKET_TERMINAL_ADDR=$(ADDR) go run .

dev:
	./scripts/dev.sh

ui-smoke:
	cd $(FRONTEND) && node scripts/ui-smoke.mjs

verify:
	./scripts/verify.sh --start

clean:
	rm -f $(BACKEND)/terminald
	rm -rf $(FRONTEND)/dist
