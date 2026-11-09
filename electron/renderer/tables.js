import { icon } from './icons.js';
import { readPreference, writePreference } from './appearance.js';

const TABLES = {
  nodes: [
    ['index', '#', 56, 48], ['name', '节点名称', 260, 160],
    ['address', 'IP地址', 200, 140], ['protocol', '协议', 100, 80], ['path', 'path', 300, 160]
  ],
  accounts: [
    ['account', '账号', 240, 160], ['brand', '加速器', 110, 90],
    ['status', '状态', 160, 120], ['expiry', '到期', 150, 120],
    ['usage', '使用', 180, 140], ['actions', '操作', 96, 80]
  ]
};
const initialized = new WeakSet();
const MAX_WIDTH = 900;

function normalizeLayout(name) {
  const columns = TABLES[name];
  const saved = readPreference(`autovpn.table.${name}`, {});
  const validKeys = columns.map(([key]) => key);
  const order = [...new Set(Array.isArray(saved?.order) ? saved.order : [])]
    .filter((key) => validKeys.includes(key));
  const widths = Object.fromEntries(columns.map(([key, , initial, minimum]) => {
    const width = saved?.widths?.[key];
    return [key, typeof width === 'number' && Number.isFinite(width)
      ? Math.max(minimum, Math.min(MAX_WIDTH, width)) : initial];
  }));
  return { order: [...order, ...validKeys.filter((key) => !order.includes(key))], widths };
}

export function enhanceTables(root) {
  for (const table of root.querySelectorAll('[data-column-table]')) {
    const name = table.dataset.columnTable;
    if (!TABLES[name] || initialized.has(table)) continue;
    initialized.add(table);
    enhanceTable(table, name);
  }
}

function enhanceTable(table, name) {
  const columns = TABLES[name];
  const wrap = table.closest('.table-wrap');
  let layout = normalizeLayout(name);
  const headers = [...table.tHead.rows[0].cells];
  const colgroup = table.querySelector('colgroup') ?? table.insertBefore(document.createElement('colgroup'), table.firstChild);
  colgroup.replaceChildren(...columns.map(([key]) => {
    const col = document.createElement('col');
    col.dataset.columnKey = key;
    return col;
  }));
  for (const row of table.rows) {
    if (row.cells.length !== columns.length) continue;
    [...row.cells].forEach((cell, index) => { cell.dataset.columnKey = columns[index][0]; });
  }
  wrap.tabIndex = 0;
  wrap.setAttribute('role', 'region');
  wrap.setAttribute('aria-label', name === 'nodes' ? '节点列表，可横向滚动' : '账号列表，可横向滚动');

  const tools = document.createElement('div');
  tools.className = 'table-tools';
  tools.innerHTML = `<span class="sr-only" role="status" aria-live="polite"></span>
    <details class="column-options"><summary title="调整列表列" aria-label="调整列表列">${icon('columns')}</summary>
      <div class="column-options-body"><div class="column-options-heading"><span>顺序与列宽</span><button class="btn btn-secondary small" data-columns-reset type="button">重置</button></div>
        ${columns.map(([key, label, , minimum]) => `<div class="column-option" data-column-option="${key}"><span>${label}</span><button class="icon-btn" data-column-move="left" aria-label="左移${label}列" title="左移${label}列" type="button">${icon('left')}</button><button class="icon-btn" data-column-move="right" aria-label="右移${label}列" title="右移${label}列" type="button">${icon('right')}</button><label class="column-width"><span class="sr-only">${label}列宽，像素</span><input type="number" inputmode="numeric" data-column-width="${key}" min="${minimum}" max="${MAX_WIDTH}" step="16" /></label></div>`).join('')}
      </div></details>`;
  wrap.before(tools);
  const options = tools.querySelector('details');
  tools.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      options.open = false;
      options.querySelector('summary').focus();
    }
  });
  const save = () => writePreference(`autovpn.table.${name}`, layout);
  const announce = (text) => { tools.querySelector('[role="status"]').textContent = text; };
  const apply = () => {
    for (const row of [colgroup, ...table.rows]) {
      const cells = new Map([...row.children].map((cell) => [cell.dataset.columnKey, cell]));
      if (cells.size !== columns.length || cells.has(undefined)) continue;
      // Reparenting the captured resize handle on every pointermove cancels
      // pointer capture after the first movement. Only reorder changed rows.
      const currentOrder = [...row.children].map((cell) => cell.dataset.columnKey);
      if (currentOrder.some((key, index) => key !== layout.order[index])) {
        row.append(...layout.order.map((key) => cells.get(key)));
      }
    }
    for (const [key, label] of columns) {
      colgroup.querySelector(`[data-column-key="${key}"]`).style.width = `${layout.widths[key]}px`;
      const handle = table.querySelector(`[data-column-key="${key}"] .column-resize`);
      handle?.setAttribute('aria-valuenow', String(Math.round(layout.widths[key])));
      handle?.setAttribute('aria-valuetext', `${Math.round(layout.widths[key])} 像素`);
      const option = tools.querySelector(`[data-column-option="${key}"]`);
      option.querySelector('input').value = String(Math.round(layout.widths[key]));
      option.querySelector('[data-column-move="left"]').disabled = layout.order[0] === key;
      option.querySelector('[data-column-move="right"]').disabled = layout.order.at(-1) === key;
      option.style.order = layout.order.indexOf(key);
    }
    table.style.width = `${Object.values(layout.widths).reduce((sum, width) => sum + width, 0)}px`;
  };
  const move = (key, targetIndex) => {
    const index = layout.order.indexOf(key);
    const target = Math.max(0, Math.min(layout.order.length - 1, targetIndex));
    if (index === target) return;
    layout.order.splice(index, 1);
    layout.order.splice(target, 0, key);
    const focused = document.activeElement;
    apply();
    // Moving an existing header detaches its focused grip. Restore it so
    // successive keyboard moves stay on the same column.
    if (focused instanceof HTMLElement && table.contains(focused)) focused.focus();
    save();
    announce(`已将${columns.find(([id]) => id === key)[1]}移到第 ${target + 1} 列`);
  };
  const resize = (key, value) => {
    const minimum = columns.find(([id]) => id === key)[3];
    if (!Number.isFinite(value)) return;
    layout.widths[key] = Math.max(minimum, Math.min(MAX_WIDTH, value));
    apply();
  };
  let draggedKey = null;
  headers.forEach((header, index) => {
    const [key, label, , minimum] = columns[index];
    header.innerHTML = `<div class="column-heading"><button class="column-grip" draggable="true" type="button" aria-label="移动${label}列" title="拖动调整顺序；Alt + 左右键移动">${icon('grip')}</button><span>${label}</span></div><span class="column-resize" role="separator" tabindex="0" aria-orientation="vertical" aria-label="调整${label}列宽" aria-valuemin="${minimum}" aria-valuemax="${MAX_WIDTH}" title="拖动调整列宽；左右键调整"></span>`;
    header.scope = 'col';
    header.addEventListener('dragstart', (event) => {
      if (!event.target.closest('.column-grip')) return;
      draggedKey = key;
      event.dataTransfer.setData('text/plain', key);
      event.dataTransfer.effectAllowed = 'move';
      header.classList.add('is-dragging');
    });
    header.addEventListener('dragover', (event) => {
      if (!draggedKey) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    });
    header.addEventListener('drop', (event) => {
      if (!draggedKey) return;
      event.preventDefault();
      move(draggedKey, layout.order.indexOf(key));
      table.querySelector(`[data-column-key="${draggedKey}"] .column-grip`).focus();
      draggedKey = null;
    });
    header.addEventListener('dragend', () => {
      draggedKey = null;
      header.classList.remove('is-dragging');
    });
    header.querySelector('.column-grip').addEventListener('keydown', (event) => {
      if (!event.altKey || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      move(key, layout.order.indexOf(key) + (event.key === 'ArrowLeft' ? -1 : 1));
    });
    const handle = header.querySelector('.column-resize');
    let start = null;
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      // Freeze rendered widths before resizing so a table stretched to fit its
      // container does not redistribute every other column during the drag.
      for (const cell of headers) layout.widths[cell.dataset.columnKey] = cell.getBoundingClientRect().width;
      start = { x: event.clientX, width: layout.widths[key] };
      handle.setPointerCapture(event.pointerId);
      table.classList.add('is-resizing');
    });
    handle.addEventListener('pointermove', (event) => {
      if (start) resize(key, start.width + event.clientX - start.x);
    });
    const endResize = () => {
      if (!start) return;
      start = null;
      table.classList.remove('is-resizing');
      save();
    };
    handle.addEventListener('pointerup', endResize);
    handle.addEventListener('lostpointercapture', endResize);
    handle.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const value = event.key === 'Home' ? minimum : event.key === 'End' ? MAX_WIDTH
        : layout.widths[key] + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 64 : 16);
      resize(key, value);
      save();
    });
  });
  tools.addEventListener('click', (event) => {
    if (event.target.closest('[data-columns-reset]')) {
      layout = { order: columns.map(([key]) => key), widths: Object.fromEntries(columns.map(([key, , width]) => [key, width])) };
      apply();
      save();
      announce('已重置列顺序与宽度');
      return;
    }
    const button = event.target.closest('[data-column-move]');
    if (!button) return;
    const key = button.closest('[data-column-option]').dataset.columnOption;
    move(key, layout.order.indexOf(key) + (button.dataset.columnMove === 'left' ? -1 : 1));
    if (button.disabled) button.parentElement.querySelector(`[data-column-move="${button.dataset.columnMove === 'left' ? 'right' : 'left'}"]`).focus();
  });
  tools.addEventListener('change', (event) => {
    const key = event.target.dataset.columnWidth;
    if (!key) return;
    resize(key, event.target.valueAsNumber);
    apply();
    save();
  });
  apply();
}
