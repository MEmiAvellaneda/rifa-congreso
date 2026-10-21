// Rifa: números del 0000 al 9999, repartidos al azar entre alumnos.
// Los datos viven en Firebase (Firestore) y se comparten en tiempo real:
//   config/main      { price, goal, prizes: [{ id, name, winner }] }
//   students/{id}    { name, numbers: ["0042", ...] }
//   sales/{número}   { buyer, phone, studentId|null, paid, proofId, ts, paidAt, price, by }
//   proofs/{id}      { data: "data:image/jpeg;base64,..." }
// `state` es una copia local que se mantiene al día con onSnapshot.

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, signInWithPopup, signOut, onAuthStateChanged,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js';
import {
  getFirestore, collection, doc, onSnapshot, setDoc, getDoc, getDocs, deleteDoc, runTransaction, writeBatch,
} from 'https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';

const TOTAL = 10000;
const BLOCK_SIZE = 100;
const MIN_PER_STUDENT = 10;
const MAX_ROWS = 300;
const DAY = 86400000;
const DIRECT = 'Venta directa (sin alumno)';

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(4, '0');
const money = (n) => '$' + Math.round(n).toLocaleString('es-AR');

const defaultPrizes = () => [{ id: 'p' + Date.now(), name: 'Computadora', winner: '' }];
const state = { price: 0, goal: 0, prizes: defaultPrizes(), students: {}, sales: {} };
let currentBlock = 0;
const picked = new Set(); // números tocados en el formulario de venta

let auth;
let db;

/* ---------- Utilidades ---------- */

// "0042, 0100-0102, 7" -> ["0042","0100","0101","0102","0007"]
function parseNumbers(text) {
  const result = new Set();
  for (const token of text.split(/[\s,;]+/).filter(Boolean)) {
    const m = token.match(/^(\d{1,4})(?:-(\d{1,4}))?$/);
    if (!m) return { error: `"${token}" no es un número válido (0000-9999).` };
    const from = Number(m[1]);
    const to = m[2] === undefined ? from : Number(m[2]);
    if (to < from) return { error: `El rango "${token}" está al revés.` };
    if (to - from > 500) return { error: `El rango "${token}" es demasiado grande.` };
    for (let i = from; i <= to; i++) result.add(pad(i));
  }
  if (result.size === 0) return { error: 'Ingresá al menos un número.' };
  return { numbers: [...result].sort() };
}

function setMsg(node, text, kind) {
  node.textContent = text;
  node.className = 'msg' + (kind ? ' ' + kind : '');
}

function showError(err) {
  alert('No se pudo guardar: ' + (err && err.message ? err.message : err));
}

function download(filename, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function el(tag, props = {}, text) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  if (text !== undefined) node.textContent = text;
  return node;
}

const startOfDay = (t) => new Date(t).setHours(0, 0, 0, 0);
const fmtDate = (t) => (t ? new Date(t).toLocaleDateString('es-AR') : '—');
const sortedStudentIds = () => Object.keys(state.students).sort((a, b) =>
  state.students[a].name.localeCompare(state.students[b].name, 'es'));

// número -> id del alumno al que está asignado
function ownerMap() {
  const map = {};
  for (const [id, s] of Object.entries(state.students)) {
    for (const n of s.numbers) map[n] = id;
  }
  return map;
}

const studentName = (id) => (id && state.students[id] ? state.students[id].name : 'Venta directa');

// Estadísticas de un alumno (o de las ventas directas si id es null)
function statsFor(id) {
  const numbers = id ? state.students[id].numbers : [];
  const sales = Object.values(state.sales).filter((s) => (s.studentId || null) === id);
  const paid = sales.filter((s) => s.paid);
  return {
    assigned: numbers.length,
    sold: sales.length,
    paid: paid.length,
    collected: paid.reduce((t, s) => t + s.price, 0),
    pending: sales.filter((s) => !s.paid).reduce((t, s) => t + s.price, 0),
  };
}

// Varios cambios seguidos llegan juntos: se dibuja una sola vez por cuadro.
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderAll(); });
}

/* ---------- Comprobantes (Firestore) ---------- */

const putProof = (id, data) => setDoc(doc(db, 'proofs', id), { data });
const deleteProof = (id) => deleteDoc(doc(db, 'proofs', id));
async function getProof(id) {
  const snap = await getDoc(doc(db, 'proofs', id));
  return snap.exists() ? snap.data().data : null;
}
async function allProofs() {
  const snap = await getDocs(collection(db, 'proofs'));
  return Object.fromEntries(snap.docs.map((d) => [d.id, d.data().data]));
}

// Reduce la foto para que ocupe poco (un documento de Firestore admite hasta 1 MB).
function compressImage(file) {
  const attempts = [[1000, 0.7], [800, 0.5], [600, 0.4]];
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      for (const [maxSide, quality] of attempts) {
        const k = Math.min(1, maxSide / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * k);
        canvas.height = Math.round(img.height * k);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        const data = canvas.toDataURL('image/jpeg', quality);
        if (data.length < 700000) return resolve(data);
      }
      reject(new Error('La imagen es demasiado pesada.'));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('No se pudo leer la imagen.')); };
    img.src = url;
  });
}

/* ---------- Asignación aleatoria ---------- */

// Elige `count` números al azar entre los que no están asignados ni vendidos.
function pickRandom(count) {
  const owner = ownerMap();
  const pool = [];
  for (let i = 0; i < TOTAL; i++) {
    const n = pad(i);
    if (!owner[n] && !state.sales[n]) pool.push(n);
  }
  if (count > pool.length) return { error: `Solo quedan ${pool.length} números sin asignar.` };
  // Fisher-Yates parcial: los primeros `count` quedan al azar
  for (let i = 0; i < count; i++) {
    const j = i + Math.floor(Math.random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return { numbers: pool.slice(0, count).sort() };
}

$('student-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('student-msg');
  const name = $('s-name').value.trim();
  const count = Number($('s-count').value);
  if (!name) return setMsg(msg, 'Falta el nombre.', 'error');
  if (!Number.isInteger(count) || count < MIN_PER_STUDENT) {
    return setMsg(msg, `Cada alumno debe tener al menos ${MIN_PER_STUDENT} números.`, 'error');
  }
  if (name.toLowerCase() === DIRECT.toLowerCase()) return setMsg(msg, 'Ese nombre no está disponible.', 'error');
  const exists = Object.values(state.students).some((s) => s.name.toLowerCase() === name.toLowerCase());
  if (exists) return setMsg(msg, 'Ya hay un alumno con ese nombre.', 'error');

  const result = pickRandom(count);
  if (result.error) return setMsg(msg, result.error, 'error');
  try {
    await setDoc(doc(db, 'students', 's' + Date.now()), { name, numbers: result.numbers });
  } catch (err) {
    return showError(err);
  }
  $('s-name').value = '';
  setMsg(msg, `${name}: ${count} números asignados.`, 'ok');
});

/* ---------- Render: resumen ---------- */

function renderStats() {
  const sales = Object.values(state.sales);
  const paid = sales.filter((s) => s.paid);
  const collected = paid.reduce((t, s) => t + s.price, 0);
  const owner = ownerMap();
  const assignedUnsold = Object.keys(owner).filter((n) => !state.sales[n]).length;
  const used = new Set([...Object.keys(owner), ...Object.keys(state.sales)]);

  $('st-vendidos').textContent = sales.length;
  $('st-pagados').textContent = paid.length;
  $('st-pendientes').textContent = sales.length - paid.length;
  $('st-asignados').textContent = assignedUnsold;
  $('st-libres').textContent = TOTAL - used.size;
  $('st-cobrado').textContent = money(collected);
  $('st-porcobrar').textContent = money(sales.filter((s) => !s.paid).reduce((t, s) => t + s.price, 0));

  $('bar-sold').style.width = (sales.length / TOTAL * 100) + '%';
  $('lbl-sold').textContent = `${sales.length} de ${TOTAL}`;
  const goalPct = state.goal > 0 ? Math.min(100, collected / state.goal * 100) : 0;
  $('bar-goal').style.width = goalPct + '%';
  $('lbl-goal').textContent = state.goal > 0
    ? `${money(collected)} de ${money(state.goal)} (${Math.round(goalPct)}%)`
    : 'Definí una meta para ver el avance';
}

/* ---------- Render: gráficos (SVG sin librerías) ---------- */

const SVG_NS = 'http://www.w3.org/2000/svg';
function svgEl(tag, attrs = {}, text) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  if (text !== undefined) node.textContent = text;
  return node;
}

const COLOR_SOLD = '#2f5bea';
const COLOR_PAID = '#16a34a';
const COLOR_PENDING = '#f59e0b';
const COLOR_GOAL = '#dc2626';
const COLOR_AXIS = '#94a3b8';

function renderLineChart() {
  const box = $('chart-line');
  box.textContent = '';
  const sales = Object.values(state.sales).filter((s) => s.ts);
  if (!sales.length) return void (box.textContent = 'Todavía no hay ventas registradas.');

  const start = startOfDay(Math.min(...sales.map((s) => s.ts)));
  const days = Math.min(366, Math.round((startOfDay(Date.now()) - start) / DAY) + 1);
  const soldPerDay = new Array(days).fill(0);
  const paidPerDay = new Array(days).fill(0);
  const dayIndex = (t) => Math.max(0, Math.min(days - 1, Math.round((startOfDay(t) - start) / DAY)));
  for (const s of sales) {
    soldPerDay[dayIndex(s.ts)] += s.price;
    if (s.paid) paidPerDay[dayIndex(s.paidAt || s.ts)] += s.price;
  }
  const cumulative = (arr) => arr.reduce((acc, v, i) => (acc.push((acc[i - 1] || 0) + v), acc), []);
  const sold = cumulative(soldPerDay);
  const paid = cumulative(paidPerDay);

  const W = 640, H = 260, L = 64, R = 16, T = 34, B = 34;
  const yMax = Math.max(sold[days - 1], state.goal, 1);
  const x = (i) => L + (days === 1 ? 0 : i / (days - 1) * (W - L - R));
  const y = (v) => T + (1 - v / yMax) * (H - T - B);

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Evolución acumulada de ventas y cobros' });
  for (let i = 0; i <= 4; i++) {
    const v = yMax * i / 4;
    svg.append(svgEl('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), stroke: '#e5e7eb' }));
    svg.append(svgEl('text', { x: L - 8, y: y(v) + 4, 'text-anchor': 'end', 'font-size': 11, fill: COLOR_AXIS }, money(v)));
  }
  const labelAt = (i) => fmtDate(start + i * DAY);
  svg.append(svgEl('text', { x: L, y: H - 10, 'font-size': 11, fill: COLOR_AXIS }, labelAt(0)));
  if (days > 1) svg.append(svgEl('text', { x: W - R, y: H - 10, 'text-anchor': 'end', 'font-size': 11, fill: COLOR_AXIS }, labelAt(days - 1)));

  if (state.goal > 0) {
    svg.append(svgEl('line', { x1: L, x2: W - R, y1: y(state.goal), y2: y(state.goal), stroke: COLOR_GOAL, 'stroke-dasharray': '6 4' }));
  }
  const drawSeries = (values, color) => {
    const points = values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
    svg.append(svgEl('polyline', { points, fill: 'none', stroke: color, 'stroke-width': 2.5, 'stroke-linejoin': 'round' }));
    if (days <= 31) values.forEach((v, i) => svg.append(svgEl('circle', { cx: x(i), cy: y(v), r: 3, fill: color })));
  };
  drawSeries(sold, COLOR_SOLD);
  drawSeries(paid, COLOR_PAID);

  const legend = [['Vendido', COLOR_SOLD], ['Cobrado', COLOR_PAID]];
  if (state.goal > 0) legend.push(['Meta', COLOR_GOAL]);
  legend.forEach(([label, color], i) => {
    svg.append(svgEl('rect', { x: L + i * 90, y: 8, width: 12, height: 12, rx: 3, fill: color }));
    svg.append(svgEl('text', { x: L + i * 90 + 18, y: 18, 'font-size': 12, fill: '#374151' }, label));
  });
  box.append(svg);
}

function renderBarChart() {
  const box = $('chart-bars');
  box.textContent = '';
  const rows = Object.keys(state.students).map((id) => ({ name: state.students[id].name, ...statsFor(id) }));
  const direct = statsFor(null);
  if (direct.sold) rows.push({ name: 'Venta directa', ...direct });
  if (!rows.length) return void (box.textContent = 'Todavía no hay alumnos.');
  rows.sort((a, b) => (b.collected + b.pending) - (a.collected + a.pending));

  const W = 640, L = 150, R = 90, ROW = 28, T = 30;
  const H = T + rows.length * ROW + 8;
  const max = Math.max(...rows.map((r) => r.collected + r.pending), 1);
  const scale = (v) => v / max * (W - L - R);

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Recaudación por alumno' });
  [['Cobrado', COLOR_PAID], ['Por cobrar', COLOR_PENDING]].forEach(([label, color], i) => {
    svg.append(svgEl('rect', { x: L + i * 100, y: 6, width: 12, height: 12, rx: 3, fill: color }));
    svg.append(svgEl('text', { x: L + i * 100 + 18, y: 16, 'font-size': 12, fill: '#374151' }, label));
  });
  rows.forEach((r, i) => {
    const yy = T + i * ROW;
    const name = r.name.length > 20 ? r.name.slice(0, 19) + '…' : r.name;
    svg.append(svgEl('text', { x: L - 8, y: yy + 16, 'text-anchor': 'end', 'font-size': 12, fill: '#374151' }, name));
    svg.append(svgEl('rect', { x: L, y: yy + 3, width: scale(r.collected), height: 18, fill: COLOR_PAID }));
    svg.append(svgEl('rect', { x: L + scale(r.collected), y: yy + 3, width: scale(r.pending), height: 18, fill: COLOR_PENDING }));
    svg.append(svgEl('text', { x: L + scale(r.collected + r.pending) + 6, y: yy + 16, 'font-size': 12, fill: '#374151' },
      `${money(r.collected + r.pending)} · ${r.sold}/${r.assigned || r.sold}`));
  });
  box.append(svg);
}

/* ---------- Render: alumnos (un cuadro por alumno) ---------- */

const cardMsg = {}; // id del alumno -> { text, kind }

function renderStudents() {
  const box = $('students-grid');
  box.textContent = '';
  const ids = sortedStudentIds();
  if (!ids.length) return void (box.textContent = 'Todavía no hay alumnos.');

  for (const id of ids) {
    const s = state.students[id];
    const st = statsFor(id);
    const left = s.numbers.filter((n) => !state.sales[n]).length;
    const card = el('article', { className: 'student-card' });
    card.append(el('h3', {}, s.name));
    card.append(el('p', { className: 'hint' },
      `${st.sold} de ${st.assigned} vendidos · ${st.paid} pagados · cobrado ${money(st.collected)}`));
    const bar = el('div', { className: 'progress' });
    const fill = el('div', { className: 'fill goal' });
    fill.style.width = (st.assigned ? st.sold / st.assigned * 100 : 0) + '%';
    bar.append(fill);
    card.append(bar);

    const chips = el('div', { className: 'chips' });
    for (const n of s.numbers) {
      const sale = state.sales[n];
      const chip = el('span', { className: 'chip ' + (sale ? (sale.paid ? 'paid' : 'pending') : '') }, n);
      chip.title = sale ? `${sale.buyer} · ${sale.paid ? 'pagado' : 'sin pagar'}` : 'Falta vender';
      chips.append(chip);
    }
    card.append(chips);

    const msg = cardMsg[id];
    card.append(el('p', { className: 'msg' + (msg ? ' ' + msg.kind : '') }, msg ? msg.text : ''));

    const actions = el('div', { className: 'btn-row' });
    const more = el('button', { type: 'button', className: left ? 'muted' : 'primary' }, 'Pedir más números');
    more.dataset.act = 'more';
    const copy = el('button', { type: 'button' }, 'Copiar lista');
    copy.dataset.act = 'copy';
    const del = el('button', { type: 'button', className: 'danger' }, 'Eliminar');
    del.dataset.act = 'delete';
    for (const b of [more, copy, del]) { b.dataset.id = id; actions.append(b); }
    card.append(actions);
    box.append(card);
  }
}

$('students-grid').addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) return;
  const id = btn.dataset.id;
  const s = state.students[id];
  const say = (text, kind) => { cardMsg[id] = { text, kind }; renderStudents(); };

  if (btn.dataset.act === 'more') {
    const left = s.numbers.filter((n) => !state.sales[n]).length;
    if (left > 0) return say(`Primero tiene que vender los ${left} números que le quedan.`, 'error');
    const input = prompt(`¿Cuántos números más para ${s.name}?`, String(MIN_PER_STUDENT));
    if (input === null) return;
    const count = Number(input);
    if (!Number.isInteger(count) || count < 1) return say('Cantidad inválida.', 'error');
    const result = pickRandom(count);
    if (result.error) return say(result.error, 'error');
    try {
      await setDoc(doc(db, 'students', id), { numbers: [...s.numbers, ...result.numbers].sort() }, { merge: true });
      cardMsg[id] = { text: `Se asignaron ${count} números nuevos.`, kind: 'ok' };
    } catch (err) {
      showError(err);
    }
  } else if (btn.dataset.act === 'copy') {
    const free = s.numbers.filter((n) => !state.sales[n]);
    const text = `${s.name} - números para vender: ${free.join(', ')}`;
    try {
      await navigator.clipboard.writeText(text);
      say('Lista copiada (solo los que faltan vender).', 'ok');
    } catch (err) {
      prompt('Copiá la lista:', text);
    }
  } else if (btn.dataset.act === 'delete') {
    if (s.numbers.some((n) => state.sales[n])) return say('No se puede eliminar: ya tiene ventas registradas.', 'error');
    if (!confirm(`¿Eliminar a ${s.name}? Sus ${s.numbers.length} números quedarán sin asignar.`)) return;
    delete cardMsg[id];
    deleteDoc(doc(db, 'students', id)).catch(showError);
  }
});

$('btn-assign-csv').addEventListener('click', () => {
  const lines = ['Alumno,Numero,Estado'];
  for (const s of Object.values(state.students)) {
    for (const n of s.numbers) {
      const sale = state.sales[n];
      lines.push([s.name, n, sale ? 'Vendido' : 'Sin vender']
        .map((v) => `"${v.replace(/"/g, '""')}"`).join(','));
    }
  }
  download('rifa-asignaciones.csv', '﻿' + lines.join('\r\n'), 'text/csv;charset=utf-8');
});

/* ---------- Registrar venta ---------- */

// Lo que se escribió en "¿Quién vendió?": un alumno, venta directa o nada válido
function chosenSeller() {
  const text = $('f-student').value.trim().toLowerCase();
  if (text === DIRECT.toLowerCase()) return { mode: 'direct', id: null };
  const id = Object.keys(state.students).find((k) => state.students[k].name.toLowerCase() === text);
  return id ? { mode: 'student', id } : { mode: 'none', id: null };
}

function renderSaleForm() {
  const list = $('students-list');
  list.textContent = '';
  for (const id of sortedStudentIds()) list.append(el('option', { value: state.students[id].name }));
  list.append(el('option', { value: DIRECT }));
  renderChips();
}

function renderChips() {
  const { mode, id } = chosenSeller();
  const typed = $('f-student').value.trim();
  $('chips-wrap').hidden = mode !== 'student';
  $('direct-wrap').hidden = mode !== 'direct';
  $('seller-hint').textContent = mode !== 'none' ? ''
    : typed ? 'No hay ningún alumno con ese nombre.' : 'Escribí el nombre y elegilo de la lista.';

  const chips = $('f-chips');
  chips.textContent = '';
  if (mode !== 'student') return;

  const free = state.students[id].numbers.filter((n) => !state.sales[n]);
  for (const n of [...picked]) if (!free.includes(n)) picked.delete(n);
  const q = $('f-filter').value.trim();
  const shown = q ? free.filter((n) => n.includes(q)) : free;
  const chosen = picked.size ? ` · elegidos: ${[...picked].sort().join(', ')}` : '';
  $('f-count').textContent = free.length
    ? `${free.length} disponibles${q ? ` · ${shown.length} coinciden con "${q}"` : ''}${chosen}`
    : 'A este alumno no le quedan números por vender.';
  for (const n of shown) {
    const chip = el('button', { type: 'button', className: 'chip pick' + (picked.has(n) ? ' sel' : '') }, n);
    chip.dataset.num = n;
    chips.append(chip);
  }
}

$('f-student').addEventListener('input', () => { picked.clear(); $('f-filter').value = ''; renderChips(); });
$('f-filter').addEventListener('input', () => {
  $('f-filter').value = $('f-filter').value.replace(/\D/g, '');
  renderChips();
});
$('f-chips').addEventListener('click', (e) => {
  const chip = e.target.closest('.chip.pick');
  if (!chip) return;
  const n = chip.dataset.num;
  if (picked.has(n)) picked.delete(n); else picked.add(n);
  renderChips();
});

$('sale-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('form-msg');
  const { mode, id } = chosenSeller();
  const owner = ownerMap();
  let numbers;

  if (mode === 'none') return setMsg(msg, 'Elegí quién vendió: escribí el nombre del alumno y elegilo de la lista.', 'error');
  if (mode === 'student') {
    numbers = [...picked].sort();
    if (!numbers.length) return setMsg(msg, 'Tocá al menos un número de la lista.', 'error');
  } else {
    const parsed = parseNumbers($('f-numbers').value);
    if (parsed.error) return setMsg(msg, parsed.error, 'error');
    numbers = parsed.numbers;
    const assigned = numbers.filter((n) => owner[n]);
    if (assigned.length) {
      return setMsg(msg, `Asignados a un alumno: ${assigned.join(', ')}. Elegí al alumno que lo vendió.`, 'error');
    }
  }
  const taken = numbers.filter((n) => state.sales[n]);
  if (taken.length) return setMsg(msg, `Ya vendidos: ${taken.join(', ')}. No se guardó nada.`, 'error');

  const buyer = $('f-buyer').value.trim();
  if (!buyer) return setMsg(msg, 'Falta el nombre de quien compró.', 'error');

  // Sin comprobante no hay venta
  const file = $('f-proof').files[0];
  if (!file) return setMsg(msg, 'Adjuntá el comprobante de pago: sin comprobante no se registra la venta.', 'error');
  if (!file.type.startsWith('image/')) return setMsg(msg, 'El comprobante tiene que ser una foto o captura de pantalla.', 'error');

  const submit = e.submitter;
  submit.disabled = true;
  setMsg(msg, 'Guardando…');
  const proofId = 'c' + Date.now();
  try {
    await putProof(proofId, await compressImage(file));
    const now = Date.now();
    // La transacción evita que dos personas vendan el mismo número a la vez
    await runTransaction(db, async (tx) => {
      const refs = numbers.map((n) => doc(db, 'sales', n));
      const snaps = await Promise.all(refs.map((r) => tx.get(r)));
      const already = numbers.filter((n, i) => snaps[i].exists());
      if (already.length) throw new Error(`Ya vendidos: ${already.join(', ')}.`);
      refs.forEach((ref) => tx.set(ref, {
        buyer,
        phone: $('f-phone').value.trim(),
        studentId: id,
        paid: true,
        proofId,
        ts: now,
        paidAt: now,
        price: state.price,
        by: auth.currentUser.email,
      }));
    });
  } catch (err) {
    deleteProof(proofId).catch(() => {});
    submit.disabled = false;
    return setMsg(msg, 'No se guardó la venta: ' + err.message, 'error');
  }
  submit.disabled = false;
  picked.clear();
  $('f-numbers').value = '';
  $('f-buyer').value = '';
  $('f-phone').value = '';
  $('f-proof').value = '';
  $('f-filter').value = '';
  setMsg(msg, `Venta guardada: ${numbers.join(', ')}`, 'ok');
});

/* ---------- Configuración (precio, meta, premios) ---------- */

let configTimer;
function saveConfig() {
  clearTimeout(configTimer);
  configTimer = setTimeout(() => {
    setDoc(doc(db, 'config', 'main'), { price: state.price, goal: state.goal, prizes: state.prizes }).catch(showError);
  }, 500);
}

const isEditing = (node) => node.contains(document.activeElement);

function applyConfig(data) {
  state.price = (data && data.price) || 0;
  state.goal = (data && data.goal) || 0;
  state.prizes = data && Array.isArray(data.prizes) ? data.prizes : defaultPrizes();
  if (document.activeElement !== $('price')) $('price').value = state.price;
  if (document.activeElement !== $('goal')) $('goal').value = state.goal;
  if (!isEditing($('prizes'))) renderPrizes();
}

$('price').addEventListener('change', () => {
  state.price = Math.max(0, Number($('price').value) || 0);
  saveConfig();
});
$('goal').addEventListener('change', () => {
  state.goal = Math.max(0, Number($('goal').value) || 0);
  saveConfig();
  scheduleRender();
});

function renderPrizes() {
  const box = $('prizes');
  box.textContent = '';
  state.prizes.forEach((prize, i) => {
    const row = el('div', { className: 'prize-row' });
    const name = el('input', { type: 'text', value: prize.name, placeholder: 'Nombre del premio' });
    const winner = el('input', { type: 'text', value: prize.winner, inputMode: 'numeric', maxLength: 4, placeholder: 'N° ganador' });
    const result = el('span', { className: 'msg' });
    const remove = el('button', { type: 'button', className: 'danger' }, 'Quitar');

    const showResult = () => {
      if (winner.value.length < 4) return setMsg(result, 'Sin sortear todavía');
      const sale = state.sales[winner.value];
      if (!sale) return setMsg(result, `El ${winner.value} no fue vendido: sin ganador.`, 'error');
      const who = sale.studentId ? ` (vendido por ${studentName(sale.studentId)})` : '';
      setMsg(result, `¡Ganó ${sale.buyer}!${sale.phone ? ' Tel: ' + sale.phone : ''}${who}`, 'ok');
    };
    name.addEventListener('input', () => { prize.name = name.value; saveConfig(); });
    winner.addEventListener('input', () => {
      winner.value = winner.value.replace(/\D/g, '');
      prize.winner = winner.value;
      saveConfig();
      showResult();
    });
    remove.addEventListener('click', () => {
      state.prizes.splice(i, 1);
      saveConfig();
      renderPrizes();
    });
    row.append(el('span', { className: 'prize-n' }, String(i + 1) + '°'), name, winner, remove, result);
    box.append(row);
    showResult();
  });
}

$('btn-add-prize').addEventListener('click', () => {
  state.prizes.push({ id: 'p' + Date.now(), name: '', winner: '' });
  saveConfig();
  renderPrizes();
});

/* ---------- Grilla ---------- */

function renderGrid() {
  const grid = $('grid');
  grid.textContent = '';
  const owner = ownerMap();
  const start = currentBlock * BLOCK_SIZE;
  for (let i = start; i < start + BLOCK_SIZE; i++) {
    const num = pad(i);
    const sale = state.sales[num];
    const btn = el('button', { type: 'button', className: 'cell' }, num);
    btn.dataset.num = num;
    if (sale) btn.classList.add(sale.paid ? 'paid' : 'pending');
    else if (owner[num]) btn.classList.add('assigned');
    btn.title = sale ? sale.buyer + ' · ' + studentName(sale.studentId)
      : owner[num] ? 'Asignado a ' + studentName(owner[num]) : 'Sin asignar';
    grid.append(btn);
  }
  $('blk-select').value = currentBlock;
}

$('grid').addEventListener('click', (e) => {
  const btn = e.target.closest('.cell');
  if (btn && state.sales[btn.dataset.num]) openDetail(btn.dataset.num);
});

for (let b = 0; b < TOTAL / BLOCK_SIZE; b++) {
  $('blk-select').append(el('option', { value: b }, `${pad(b * BLOCK_SIZE)} – ${pad(b * BLOCK_SIZE + BLOCK_SIZE - 1)}`));
}
$('blk-select').addEventListener('change', () => { currentBlock = Number($('blk-select').value); renderGrid(); });
$('blk-prev').addEventListener('click', () => { currentBlock = Math.max(0, currentBlock - 1); renderGrid(); });
$('blk-next').addEventListener('click', () => { currentBlock = Math.min(TOTAL / BLOCK_SIZE - 1, currentBlock + 1); renderGrid(); });

$('q-number').addEventListener('input', () => {
  const v = $('q-number').value.replace(/\D/g, '');
  $('q-number').value = v;
  if (v.length < 4) return setMsg($('q-result'), '');
  const sale = state.sales[v];
  const owner = ownerMap()[v];
  if (sale) setMsg($('q-result'), `Vendido a ${sale.buyer} (${studentName(sale.studentId)})`, 'error');
  else if (owner) setMsg($('q-result'), `Asignado a ${studentName(owner)}, sin vender.`, '');
  else setMsg($('q-result'), 'Sin asignar.', 'ok');
  currentBlock = Math.floor(Number(v) / BLOCK_SIZE);
  renderGrid();
});

/* ---------- Lista de ventas ---------- */

function renderTable() {
  const text = $('filter').value.trim().toLowerCase();
  const stateFilter = $('filter-state').value;
  const rows = Object.keys(state.sales).sort().filter((num) => {
    const s = state.sales[num];
    if (stateFilter === 'paid' && !s.paid) return false;
    if (stateFilter === 'pending' && s.paid) return false;
    return !text || [num, s.buyer, studentName(s.studentId)].join(' ').toLowerCase().includes(text);
  });

  const body = $('sales-body');
  body.textContent = '';
  for (const num of rows.slice(0, MAX_ROWS)) {
    const s = state.sales[num];
    const tr = el('tr');
    [num, s.buyer, s.phone || '', studentName(s.studentId), fmtDate(s.ts)].forEach((v) => tr.append(el('td', {}, v)));
    const tdState = el('td');
    tdState.append(el('span', { className: 'badge ' + (s.paid ? 'paid' : 'pending') }, s.paid ? 'Pagado' : 'Sin pagar'));
    const tdAct = el('td');
    const view = el('button', { type: 'button' }, 'Ver');
    view.dataset.num = num;
    tdAct.append(view);
    tr.append(tdState, tdAct);
    body.append(tr);
  }
  $('list-note').textContent = rows.length > MAX_ROWS
    ? `Mostrando ${MAX_ROWS} de ${rows.length}. Usá el filtro para acotar.`
    : rows.length === 0 ? 'No hay ventas para mostrar.' : '';
}

$('filter').addEventListener('input', renderTable);
$('filter-state').addEventListener('change', renderTable);
$('sales-body').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-num]');
  if (btn) openDetail(btn.dataset.num);
});

/* ---------- Detalle de venta ---------- */

let detailNum = null;

function openDetail(num) {
  const s = state.sales[num];
  if (!s) return;
  detailNum = num;
  $('d-title').textContent = 'Número ' + num;
  const info = $('d-info');
  info.textContent = '';
  const rows = [
    ['Comprador/a', s.buyer],
    ['Contacto', s.phone || '—'],
    ['Vendedor/a', studentName(s.studentId)],
    ['Fecha de venta', fmtDate(s.ts)],
    ['Precio', money(s.price)],
    ['Registrada por', s.by || '—'],
    ['Comprobante', s.proofId ? 'Adjunto' : 'Sin comprobante'],
  ];
  for (const [label, value] of rows) info.append(el('dt', {}, label), el('dd', {}, value));

  const img = $('d-proof');
  img.hidden = true;
  img.removeAttribute('src');
  if (s.proofId) {
    getProof(s.proofId).then((url) => {
      if (url && detailNum === num) { img.src = url; img.hidden = false; }
    }).catch(() => {});
  }
  $('detail').showModal();
}

$('d-delete').addEventListener('click', async () => {
  if (!confirm(`¿Eliminar la venta del ${detailNum}? El número volverá a quedar disponible.`)) return;
  const num = detailNum;
  const { proofId } = state.sales[num];
  try {
    await deleteDoc(doc(db, 'sales', num));
    // el mismo comprobante puede respaldar varios números de una misma compra
    const stillUsed = Object.entries(state.sales).some(([n, s]) => n !== num && s.proofId === proofId);
    if (proofId && !stillUsed) await deleteProof(proofId);
  } catch (err) {
    showError(err);
  }
  $('detail').close();
});

$('d-close').addEventListener('click', () => $('detail').close());

/* ---------- Exportar / respaldo ---------- */

$('btn-csv').addEventListener('click', () => {
  const quote = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = ['Numero,Comprador,Contacto,Vendedor,Fecha venta,Precio,Comprobante,Registrada por'];
  for (const num of Object.keys(state.sales).sort()) {
    const s = state.sales[num];
    lines.push([num, s.buyer, s.phone, studentName(s.studentId), fmtDate(s.ts), s.price, s.proofId ? 'Si' : 'No', s.by]
      .map(quote).join(','));
  }
  download('rifa-ventas.csv', '﻿' + lines.join('\r\n'), 'text/csv;charset=utf-8');
});

$('btn-backup').addEventListener('click', async () => {
  try {
    const data = {
      price: state.price, goal: state.goal, prizes: state.prizes,
      students: state.students, sales: state.sales, proofs: await allProofs(),
    };
    download('rifa-respaldo.json', JSON.stringify(data), 'application/json');
  } catch (e) {
    alert('No se pudo armar el respaldo: ' + e.message);
  }
});

// Firestore admite 500 operaciones por lote
async function runBatched(ops) {
  for (let i = 0; i < ops.length; i += 400) {
    const batch = writeBatch(db);
    ops.slice(i, i + 400).forEach((op) => op(batch));
    await batch.commit();
  }
}

$('btn-restore').addEventListener('click', () => $('file-restore').click());
$('file-restore').addEventListener('change', async () => {
  const file = $('file-restore').files[0];
  $('file-restore').value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (!data || typeof data.sales !== 'object' || typeof data.students !== 'object') throw new Error('formato');
    if (!confirm('Esto reemplaza los datos de TODOS con los del respaldo. ¿Continuar?')) return;
    const oldProofs = (await getDocs(collection(db, 'proofs'))).docs.map((d) => d.id);
    const ops = [];
    for (const n of Object.keys(state.sales)) ops.push((b) => b.delete(doc(db, 'sales', n)));
    for (const id of Object.keys(state.students)) ops.push((b) => b.delete(doc(db, 'students', id)));
    for (const id of oldProofs) ops.push((b) => b.delete(doc(db, 'proofs', id)));
    for (const [n, s] of Object.entries(data.sales)) ops.push((b) => b.set(doc(db, 'sales', n), s));
    for (const [id, s] of Object.entries(data.students)) ops.push((b) => b.set(doc(db, 'students', id), s));
    for (const [id, url] of Object.entries(data.proofs || {})) ops.push((b) => b.set(doc(db, 'proofs', id), { data: url }));
    ops.push((b) => b.set(doc(db, 'config', 'main'), {
      price: data.price || 0, goal: data.goal || 0, prizes: data.prizes || defaultPrizes(),
    }));
    await runBatched(ops);
    alert('Respaldo restaurado.');
  } catch (e) {
    alert('No se pudo restaurar: el archivo no es un respaldo válido o hubo un error de conexión.');
  }
});

/* ---------- Render general ---------- */

function renderAll() {
  renderStats();
  renderLineChart();
  renderBarChart();
  renderStudents();
  renderSaleForm();
  renderGrid();
  renderTable();
  if (!isEditing($('prizes'))) renderPrizes();
}

/* ---------- Ingreso y datos en tiempo real ---------- */

let unsubscribers = [];

function showGate(text, canLogin = true) {
  document.body.classList.add('locked');
  $('gate').hidden = false;
  $('gate-msg').textContent = text;
  $('btn-login').hidden = !canLogin;
}

function hideGate() {
  document.body.classList.remove('locked');
  $('gate').hidden = true;
}

function stopListening() {
  unsubscribers.forEach((u) => u());
  unsubscribers = [];
}

function startListening() {
  stopListening();
  const fail = (err) => {
    stopListening();
    showGate(err.code === 'permission-denied'
      ? 'Tu cuenta de Google no tiene permiso para entrar. Pedí que agreguen tu email.'
      : 'Error de conexión: ' + err.message);
    $('btn-login').hidden = true;
    $('btn-gate-logout').hidden = false;
  };
  const watch = (name, apply) => onSnapshot(collection(db, name), (snap) => {
    apply(Object.fromEntries(snap.docs.map((d) => [d.id, d.data()])));
    scheduleRender();
  }, fail);

  unsubscribers.push(
    onSnapshot(doc(db, 'config', 'main'), (snap) => { applyConfig(snap.data()); scheduleRender(); }, fail),
    watch('students', (data) => { state.students = data; }),
    watch('sales', (data) => { state.sales = data; }),
  );
}

$('btn-login').addEventListener('click', async () => {
  try {
    await signInWithPopup(auth, new GoogleAuthProvider());
  } catch (err) {
    $('gate-msg').textContent = 'No se pudo ingresar: ' + err.message;
  }
});
const logout = () => signOut(auth);
$('btn-logout').addEventListener('click', logout);
$('btn-gate-logout').addEventListener('click', logout);

function start() {
  const cfg = firebaseConfig;
  if (!cfg.apiKey || cfg.apiKey === 'COMPLETAR') {
    return showGate('Falta configurar Firebase: completá firebase-config.js siguiendo SETUP.md.', false);
  }
  auth = getAuth(initializeApp(cfg));
  db = getFirestore(auth.app);
  showGate('Ingresá con tu cuenta de Google para ver y registrar ventas.');
  onAuthStateChanged(auth, (user) => {
    if (!user) {
      stopListening();
      $('userbar').hidden = true;
      $('btn-gate-logout').hidden = true;
      return showGate('Ingresá con tu cuenta de Google para ver y registrar ventas.');
    }
    $('user-email').textContent = user.email;
    $('userbar').hidden = false;
    hideGate();
    startListening();
  });
}

start();
