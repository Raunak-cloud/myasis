import { useLayoutEffect, useRef, type ReactNode } from 'react';

/**
 * A data table that becomes one card per row on a phone.
 *
 * Wide tables used to scroll sideways inside their card, so on a phone most
 * columns sat off the edge with nothing but a faint shadow saying so. Below
 * the phone breakpoint (index.css, `.stacked-table`) each row is a card and
 * each cell a line under its column's name.
 *
 * The names come from the table's own header row: after every render each
 * body cell is given its column's heading as `data-label`, which the CSS
 * prints in front of it, so a table never states its headings twice and a new
 * column is labelled without anyone remembering to. Cells under an empty
 * heading (a row's buttons) get no label.
 *
 * Changing a table's `display` makes some browsers drop its table semantics,
 * so the roles are set explicitly and screen readers still hear a table.
 */
export function StackedTable({ className, children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLTableElement>(null);

  // No dependency list: rows change whenever the parent renders, and this is a few attribute writes.
  useLayoutEffect(() => {
    const table = ref.current;
    if (!table) return;
    const headings: string[] = [];
    for (const cell of table.tHead?.rows[0]?.cells ?? []) {
      for (let span = 0; span < cell.colSpan; span++) headings.push(cell.textContent?.trim() ?? '');
    }
    table.setAttribute('role', 'table');
    for (const group of [table.tHead, ...table.tBodies]) group?.setAttribute('role', 'rowgroup');
    for (const row of table.rows) {
      row.setAttribute('role', 'row');
      let column = 0;
      for (const cell of row.cells) {
        const heading = headings[column] ?? '';
        if (cell.tagName === 'TH') {
          cell.setAttribute('role', 'columnheader');
        } else {
          cell.setAttribute('role', 'cell');
          if (heading) cell.dataset.label = heading;
          else delete cell.dataset.label;
        }
        column += cell.colSpan;
      }
    }
  });

  return (
    <table ref={ref} className={className ? `stacked-table ${className}` : 'stacked-table'}>
      {children}
    </table>
  );
}
