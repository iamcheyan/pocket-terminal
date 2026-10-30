import {useEffect, useMemo, useRef, useState} from 'react';
import {CornerDownLeft, Search} from 'lucide-react';

export interface PaletteCommand {
  id: string;
  title: string;
  detail?: string;
  group: string;
  keywords?: string;
  run: () => void;
}

export interface CommandPaletteProps {
  commands: PaletteCommand[];
  onClose: () => void;
  open: boolean;
}

const score = (command: PaletteCommand, needle: string): number => {
  if (!needle) return 1;
  const haystack = `${command.title} ${command.detail ?? ''} ${command.group} ${command.keywords ?? ''}`.toLowerCase();
  const title = command.title.toLowerCase();
  if (title.startsWith(needle)) return 4;
  if (title.includes(needle)) return 3;
  if (haystack.includes(needle)) return 2;
  // Fuzzy: every needle character appears in order.
  let cursor = 0;
  for (const char of needle) {
    const next = haystack.indexOf(char, cursor);
    if (next === -1) return 0;
    cursor = next + 1;
  }
  return 1;
};

/**
 * Raycast-style palette. Keyboard (type + arrows + Enter), DPad (arrows +
 * confirm) and touch all drive the same `aria-selected` option list.
 */
const CommandPalette = ({commands, onClose, open}: CommandPaletteProps) => {
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const results = useMemo(() => {
    const needle = query.trim().toLowerCase();
    // Empty query keeps the caller's grouping; a search orders by relevance.
    if (!needle) return commands.slice(0, 40);
    return commands
      .map(command => ({command, rank: score(command, needle)}))
      .filter(entry => entry.rank > 0)
      .sort((a, b) => b.rank - a.rank || a.command.title.localeCompare(b.command.title))
      .slice(0, 40)
      .map(entry => entry.command);
  }, [commands, query]);

  useEffect(() => {
    if (open) {
      setQuery('');
      setCursor(0);
      window.setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  useEffect(() => {
    if (cursor > results.length - 1) setCursor(Math.max(0, results.length - 1));
  }, [cursor, results.length]);

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(`[data-index="${cursor}"]`);
    node?.scrollIntoView({block: 'nearest'});
  }, [cursor]);

  if (!open) return null;

  const run = (index: number) => {
    const command = results[index];
    if (!command) return;
    onClose();
    command.run();
  };

  return (
    <div
      className="scrim"
      style={{alignItems: 'flex-start'}}
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={event => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setCursor(index => Math.min(results.length - 1, index + 1));
          } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            setCursor(index => Math.max(0, index - 1));
          } else if (event.key === 'Home') {
            event.preventDefault();
            setCursor(0);
          } else if (event.key === 'End') {
            event.preventDefault();
            setCursor(Math.max(0, results.length - 1));
          } else if (event.key === 'Enter') {
            event.preventDefault();
            run(cursor);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <div className="palette-input">
          <Search size={15} />
          <input
            ref={inputRef}
            value={query}
            placeholder="Search actions, pages, hosts…"
            aria-label="Palette query"
            aria-controls="palette-list"
            aria-activedescendant={`palette-item-${cursor}`}
            onChange={event => {
              setQuery(event.target.value);
              setCursor(0);
            }}
          />
          <kbd>esc</kbd>
        </div>
        <div className="palette-list" id="palette-list" role="listbox" aria-label="Commands" ref={listRef}>
          {results.length === 0 ? (
            <div className="hint" style={{padding: 12}}>
              No commands match “{query}”.
            </div>
          ) : (
            results.map((command, index) => {
              const previous = results[index - 1];
              const showGroup = !previous || previous.group !== command.group;
              return (
                <div key={command.id}>
                  {showGroup ? <div className="palette-group">{command.group}</div> : null}
                  <button
                    type="button"
                    id={`palette-item-${index}`}
                    data-index={index}
                    role="option"
                    aria-selected={cursor === index}
                    className="palette-item"
                    onMouseEnter={() => setCursor(index)}
                    onClick={() => run(index)}
                    data-kb
                  >
                    <span className="pi-main">
                      <strong>{command.title}</strong>
                      {command.detail ? <small>{command.detail}</small> : null}
                    </span>
                    {cursor === index ? <CornerDownLeft size={12} /> : null}
                  </button>
                </div>
              );
            })
          )}
        </div>
        <div className="palette-foot">
          <span>↑↓ navigate</span>
          <span>↵ run</span>
          <span>esc close</span>
          <span style={{marginLeft: 'auto'}}>{results.length} results</span>
        </div>
      </div>
    </div>
  );
};

export default CommandPalette;
