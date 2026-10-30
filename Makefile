.PHONY: build test dev backend ui-smoke screenshots clean

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
	@echo "run 'make backend' and 'npm --prefix $(FRONTEND) run dev' in two shells"

ui-smoke:
	cd $(FRONTEND) && node scripts/ui-smoke.mjs

clean:
	rm -f $(BACKEND)/terminald
	rm -rf $(FRONTEND)/dist
