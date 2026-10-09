import React, { useCallback, useEffect, useRef, useState } from 'react';

export type SectionId =
  | 'overview'
  | 'correlation'
  | 'sectors'
  | 'signals'
  | 'detail'
  | 'research';

export interface SectionDef {
  id: SectionId;
  label: string;
  short: string;
  icon: string;
  /** Extra hint shown next to the label, e.g. a count. */
  badge?: number;
}

interface SectionNavProps {
  sections: SectionDef[];
  active: SectionId;
  onChange: (id: SectionId) => void;
}

/**
 * Section switcher.
 *
 * The dashboard grows without bound — a full sweep ranks 2,000+ coins and
 * every panel stacks vertically, so the page becomes tens of thousands of
 * pixels tall and unusable by scrolling. This collapses the same content into
 * one section at a time.
 *
 * Deliberate choices:
 * - Renders ALL sections but hides inactive ones with `hidden`. Keeping them
 *   mounted preserves component state (matrix basket, expanded rows, filters)
 *   so switching back and forth is free rather than a refetch.
 * - Arrow keys move between sections, which is how a dense dashboard gets
 *   used with the keyboard.
 * - Scroll position is reset on change, otherwise you land mid-page in a
 *   section that is only 200px tall.
 */
export default function SectionNav({ sections, active, onChange }: SectionNavProps) {
  const ref = useRef<HTMLDivElement>(null);
  const btnRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const focusIndex = useCallback(
    (idx: number) => {
      const clamped = (idx + sections.length) % sections.length;
      const id = sections[clamped].id;
      onChange(id);
      // Focus after the re-render so the button exists.
      requestAnimationFrame(() => btnRefs.current[id]?.focus());
    },
    [sections, onChange],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    const idx = sections.findIndex((s) => s.id === active);
    if (e.key === 'ArrowRight') {
      e.preventDefault();
      focusIndex(idx + 1);
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      focusIndex(idx - 1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      focusIndex(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      focusIndex(sections.length - 1);
    }
  };

  return (
    <div
      ref={ref}
      role="tablist"
      aria-label="Dashboard sections"
      onKeyDown={onKeyDown}
      style={{
        display: 'flex',
        gap: '4px',
        overflowX: 'auto',
        scrollbarWidth: 'none',
        borderBottom: '1px solid #374151',
        marginBottom: '20px',
        WebkitOverflowScrolling: 'touch',
      }}
    >
      {sections.map((s) => {
        const isActive = s.id === active;
        return (
          <button
            key={s.id}
            ref={(el) => { btnRefs.current[s.id] = el; }}
            role="tab"
            aria-selected={isActive}
            aria-controls={`section-${s.id}`}
            id={`tab-${s.id}`}
            tabIndex={isActive ? 0 : -1}
            onClick={() => onChange(s.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '7px',
              padding: '9px 14px',
              background: 'transparent',
              border: 'none',
              borderBottom: `2px solid ${isActive ? '#3b82f6' : 'transparent'}`,
              color: isActive ? '#f9fafb' : '#9ca3af',
              fontSize: '13px',
              fontWeight: isActive ? 700 : 600,
              cursor: 'pointer',
              whiteSpace: 'nowrap',
              transition: 'color 0.15s, border-color 0.15s',
            }}
          >
            <span aria-hidden="true">{s.icon}</span>
            <span>{s.label}</span>
            {typeof s.badge === 'number' && s.badge > 0 && (
              <span style={{
                background: isActive ? 'rgba(59,130,246,0.25)' : '#1f2937',
                color: isActive ? '#93c5fd' : '#6b7280',
                borderRadius: '9px',
                padding: '1px 7px',
                fontSize: '10px',
                fontWeight: 700,
                fontVariantNumeric: 'tabular-nums',
              }}>
                {s.badge > 999 ? '999+' : s.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Wraps one section. Hidden sections stay mounted so their state survives a
 * tab switch, but are removed from the accessibility tree and tab order.
 */
export function Section({
  id,
  active,
  children,
}: {
  id: SectionId;
  active: SectionId;
  children: React.ReactNode;
}) {
  return (
    <div
      role="tabpanel"
      id={`section-${id}`}
      aria-labelledby={`tab-${id}`}
      hidden={id !== active}
    >
      {children}
    </div>
  );
}

/**
 * Reads the initial section from the URL hash so a tab is linkable and
 * survives reload. Falls back to the first section on anything unrecognised.
 */
export function useHashSection(fallback: SectionId): [SectionId, (id: SectionId) => void] {
  const [active, setActive] = useState<SectionId>(fallback);

  useEffect(() => {
    const read = () => {
      const raw = window.location.hash.replace('#', '') as SectionId;
      if (raw) setActive(raw);
    };
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);

  const change = useCallback((id: SectionId) => {
    setActive(id);
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', `#${id}`);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, []);

  return [active, change];
}