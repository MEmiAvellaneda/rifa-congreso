// Bono Contribución: números del 0000 al 9999, repartidos al azar entre alumnos.
// Los datos viven en Firebase (Firestore) y se comparten en tiempo real:
//   config/main      { goal, prizes: [{ id, name, desc, winner }], ad: { title, contact, draw, promo, about } }
//   students/{id}    { name, phone, numbers: ["0042", ...] }
//   sales/{número}   { buyer, phone, studentId|null, proofId, ts, price, by }
//   proofs/{id}      { data: "data:image/jpeg;base64,..." }
//   prizeImages/{id} { data: "data:image/jpeg;base64,..." }   (id = el del premio)
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
const PRICE = 4000; // precio fijo por número
const BLOCK_SIZE = 100;
const MIN_PER_STUDENT = 15;
const MAX_ROWS = 300;
const DAY = 86400000;
const DIRECT = 'Venta directa (sin alumno)';

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(4, '0');
const money = (n) => '$' + Math.round(n).toLocaleString('es-AR');
// Las ventas con precio vacío o en 0 (de pruebas viejas) cuentan al precio fijo
const priceOf = (s) => s.price || PRICE;

const defaultPrizes = () => [
  { id: 'p' + Date.now(), name: 'Notebook', winner: '' },
  { id: 'p' + (Date.now() + 1), name: 'Auriculares', winner: '' },
];
// Textos de la imagen de publicidad (se editan desde la página)
const defaultAd = () => ({
  title: 'BONO CONTRIBUCIÓN',
  contact: '',
  draw: 'Sorteo por la Quiniela',
  promo: '',
  about: 'Somos estudiantes de Ingeniería en Sistemas y organizamos este Bono Contribución para recaudar fondos y participar del Viaje Académico y de Inmersión Tecnológica 2027. ¡Tu colaboración nos acerca a nuestro sueño!',
});

const state = { goal: 0, prizes: defaultPrizes(), ad: defaultAd(), students: {}, sales: {}, prizeImages: {} };
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
  return {
    assigned: numbers.length,
    sold: sales.length,
    collected: sales.reduce((t, s) => t + priceOf(s), 0),
  };
}

// Varios cambios seguidos llegan juntos: se dibuja una sola vez por cuadro.
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; renderAll(); });
}

// Al girar el celular cambia el ancho: se redibujan los gráficos a la medida nueva
let lastWidth = window.innerWidth;
window.addEventListener('resize', () => {
  if (window.innerWidth === lastWidth) return; // el teclado del celular cambia solo el alto
  lastWidth = window.innerWidth;
  scheduleRender();
});

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
  const phone = $('s-phone').value.trim();
  if (!name) return setMsg(msg, 'Falta el nombre.', 'error');
  if (phone.replace(/\D/g, '').length < 8) return setMsg(msg, 'Cargá el teléfono del alumno (al menos 8 números).', 'error');
  if (!Number.isInteger(count) || count < MIN_PER_STUDENT) {
    return setMsg(msg, `Cada alumno debe tener al menos ${MIN_PER_STUDENT} números.`, 'error');
  }
  if (name.toLowerCase() === DIRECT.toLowerCase()) return setMsg(msg, 'Ese nombre no está disponible.', 'error');
  const exists = Object.values(state.students).some((s) => s.name.toLowerCase() === name.toLowerCase());
  if (exists) return setMsg(msg, 'Ya hay un alumno con ese nombre.', 'error');

  const result = pickRandom(count);
  if (result.error) return setMsg(msg, result.error, 'error');
  try {
    await setDoc(doc(db, 'students', 's' + Date.now()), { name, phone, numbers: result.numbers });
  } catch (err) {
    return showError(err);
  }
  $('s-name').value = '';
  $('s-phone').value = '';
  setMsg(msg, `${name}: ${count} números asignados.`, 'ok');
  openShare(name, result.numbers, phone);
});

/* ---------- Render: resumen ---------- */

function renderStats() {
  const sales = Object.values(state.sales);
  const collected = sales.reduce((t, s) => t + priceOf(s), 0);
  const owner = ownerMap();
  const assignedUnsold = Object.keys(owner).filter((n) => !state.sales[n]).length;
  const used = new Set([...Object.keys(owner), ...Object.keys(state.sales)]);

  $('st-vendidos').textContent = sales.length;
  $('st-asignados').textContent = assignedUnsold;
  $('st-libres').textContent = TOTAL - used.size;
  $('st-cobrado').textContent = money(collected);

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

const COLOR_PAID = '#16a34a';
const COLOR_GOAL = '#dc2626';
const COLOR_AXIS = '#94a3b8';

function renderLineChart() {
  const box = $('chart-line');
  box.textContent = '';
  const sales = Object.values(state.sales).filter((s) => s.ts);
  if (!sales.length) return void (box.textContent = 'Todavía no hay ventas registradas.');

  const start = startOfDay(Math.min(...sales.map((s) => s.ts)));
  const days = Math.min(366, Math.round((startOfDay(Date.now()) - start) / DAY) + 1);
  const perDay = new Array(days).fill(0);
  const dayIndex = (t) => Math.max(0, Math.min(days - 1, Math.round((startOfDay(t) - start) / DAY)));
  for (const s of sales) perDay[dayIndex(s.ts)] += priceOf(s);
  const total = perDay.reduce((acc, v, i) => (acc.push((acc[i - 1] || 0) + v), acc), []);

  // El gráfico toma el ancho disponible (en el celular, menos que en la compu)
  const W = Math.max(300, Math.min(640, box.clientWidth || 640));
  const H = 260, L = W < 480 ? 56 : 64, R = 16, T = 34, B = 34;
  const yMax = Math.max(total[days - 1], state.goal, 1);
  const x = (i) => L + (days === 1 ? 0 : i / (days - 1) * (W - L - R));
  const y = (v) => T + (1 - v / yMax) * (H - T - B);

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Evolución acumulada de la recaudación' });
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
  drawSeries(total, COLOR_PAID);

  const legend = [['Recaudado', COLOR_PAID]];
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
  rows.sort((a, b) => b.collected - a.collected);

  const W = Math.max(300, Math.min(640, box.clientWidth || 640));
  const narrow = W < 480;
  const L = narrow ? 92 : 150, R = narrow ? 104 : 90, ROW = 28, T = 8;
  const maxName = narrow ? 12 : 20;
  const H = T + rows.length * ROW + 8;
  const max = Math.max(...rows.map((r) => r.collected), 1);
  const scale = (v) => v / max * (W - L - R);

  const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Recaudación por alumno' });
  rows.forEach((r, i) => {
    const yy = T + i * ROW;
    const name = r.name.length > maxName ? r.name.slice(0, maxName - 1) + '…' : r.name;
    svg.append(svgEl('text', { x: L - 8, y: yy + 16, 'text-anchor': 'end', 'font-size': 12, fill: '#374151' }, name));
    svg.append(svgEl('rect', { x: L, y: yy + 3, width: scale(r.collected), height: 18, fill: COLOR_PAID }));
    svg.append(svgEl('text', { x: L + scale(r.collected) + 6, y: yy + 16, 'font-size': 12, fill: '#374151' },
      `${money(r.collected)} · ${r.sold}/${r.assigned || r.sold}`));
  });
  box.append(svg);
}

/* ---------- Render: alumnos (un cuadro por alumno) ---------- */

const cardMsg = {}; // id del alumno -> { text, kind }

function renderStudents() {
  const box = $('students-grid');
  // si alguien está escribiendo un teléfono, no se redibuja para no pisarle lo que tipea
  if (isEditing(box) && document.activeElement.tagName === 'INPUT') return;
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
      `${st.sold} de ${st.assigned} vendidos · recaudado ${money(st.collected)}`));
    const bar = el('div', { className: 'progress' });
    const fill = el('div', { className: 'fill goal' });
    fill.style.width = (st.assigned ? st.sold / st.assigned * 100 : 0) + '%';
    bar.append(fill);
    card.append(bar);

    const phoneBox = el('label', { className: 'student-phone' }, 'Teléfono para reservar');
    const phoneInput = el('input', { type: 'tel', value: s.phone || '', placeholder: 'Falta cargar el teléfono' });
    phoneInput.dataset.phoneFor = id;
    if (!s.phone) phoneInput.classList.add('missing');
    phoneBox.append(phoneInput);
    card.append(phoneBox);

    const chips = el('div', { className: 'chips' });
    for (const n of s.numbers) {
      const sale = state.sales[n];
      const chip = el('span', { className: 'chip ' + (sale ? 'sold' : '') }, n);
      chip.title = sale ? `Vendido a ${sale.buyer}` : 'Falta vender';
      chips.append(chip);
    }
    card.append(chips);

    const msg = cardMsg[id];
    card.append(el('p', { className: 'msg' + (msg ? ' ' + msg.kind : '') }, msg ? msg.text : ''));

    const actions = el('div', { className: 'btn-row' });
    const more = el('button', { type: 'button', className: left ? 'muted' : 'primary' }, 'Pedir más números');
    more.dataset.act = 'more';
    const image = el('button', { type: 'button' }, 'Imagen para compartir');
    image.dataset.act = 'image';
    const copy = el('button', { type: 'button' }, 'Copiar lista');
    copy.dataset.act = 'copy';
    const del = el('button', { type: 'button', className: 'danger' }, 'Eliminar');
    del.dataset.act = 'delete';
    for (const b of [more, image, copy, del]) { b.dataset.id = id; actions.append(b); }
    card.append(actions);
    box.append(card);
  }
}

// El teléfono se guarda al terminar de escribir (al salir del campo o con Enter)
$('students-grid').addEventListener('change', async (e) => {
  const input = e.target.closest('input[data-phone-for]');
  if (!input) return;
  const id = input.dataset.phoneFor;
  const phone = input.value.trim();
  input.blur();
  if (phone && phone.replace(/\D/g, '').length < 8) {
    cardMsg[id] = { text: 'Ese teléfono parece incompleto (al menos 8 números).', kind: 'error' };
    return renderStudents();
  }
  try {
    await setDoc(doc(db, 'students', id), { phone }, { merge: true });
    cardMsg[id] = { text: phone ? 'Teléfono guardado.' : 'Teléfono borrado.', kind: 'ok' };
  } catch (err) {
    showError(err);
  }
  renderStudents();
});

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
    const all = [...s.numbers, ...result.numbers].sort();
    try {
      await setDoc(doc(db, 'students', id), { numbers: all }, { merge: true });
      cardMsg[id] = { text: `Se asignaron ${count} números nuevos.`, kind: 'ok' };
    } catch (err) {
      return showError(err);
    }
    openShare(s.name, all, s.phone); // la imagen se rehace con los números nuevos incluidos
  } else if (btn.dataset.act === 'image') {
    openShare(s.name, s.numbers, s.phone);
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

/* ---------- Imagen para compartir ---------- */
// Se dibuja en un <canvas> con los números del alumno; los ya vendidos salen tachados.

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

// Achica la letra hasta que el texto entre en el ancho disponible
function fitText(ctx, text, x, y, maxWidth, size, weight = 'bold') {
  let px = size;
  ctx.font = `${weight} ${px}px ${FONT}`;
  while (ctx.measureText(text).width > maxWidth && px > 20) {
    px -= 2;
    ctx.font = `${weight} ${px}px ${FONT}`;
  }
  ctx.fillText(text, x, y);
}

// El logo es opcional: si logo.png no está en la carpeta, la imagen se arma igual sin él.
let logoPromise;
function loadLogo() {
  logoPromise ||= new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = 'logo.png';
  });
  return logoPromise;
}

// Prepara las fotos de los premios que tienen imagen cargada: { idDelPremio: imagen }
async function loadPrizePics() {
  const pics = {};
  for (const prize of state.prizes) {
    const data = state.prizeImages[prize.id];
    if (!data) continue;
    const img = await new Promise((resolve) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => resolve(null);
      i.src = data;
    });
    if (img) pics[prize.id] = img;
  }
  return pics;
}

const INK = '#18181b';
const ACCENT = '#ea580c';

// Parte un texto en renglones que entren en el ancho dado
function wrapLines(ctx, text, maxWidth, size, weight = 'normal') {
  ctx.font = `${weight} ${size}px ${FONT}`;
  const lines = [];
  for (const paragraph of String(text).split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const test = line ? line + ' ' + word : word;
      if (line && ctx.measureText(test).width > maxWidth) { lines.push(line); line = word; } else line = test;
    }
    lines.push(line);
  }
  return lines;
}

function card(ctx, x, y, w, h, radius, fill, stroke) {
  roundRectPath(ctx, x, y, w, h, radius);
  ctx.fillStyle = fill;
  ctx.fill();
  if (stroke) { ctx.lineWidth = 3; ctx.strokeStyle = stroke; ctx.stroke(); }
}

// Dibuja la imagen de publicidad: cabecera con logo, premios con foto, precio, números del alumno y contacto.
function drawShareImage(name, numbers, logo, pics = {}, phone = '') {
  const W = 1080, M = 68, CW = W - 2 * M, CX = W / 2;
  const COLS = 5, CELL_W = 176, CELL_H = 84, GAP = 16;
  const ad = state.ad;
  const prizes = state.prizes.filter((p) => p.name.trim());

  // render dibuja todo y devuelve el alto que necesitó; se usa una vez para medir y otra para el lienzo final
  const render = (ctx, H) => {
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#f5f4f2';
    ctx.fillRect(0, 0, W, H);

    /* Cabecera */
    const logoH = logo ? Math.min(190, 620 * logo.height / logo.width) : 0;
    const logoW = logo ? logoH * logo.width / logo.height : 0;
    const top = logo ? 36 + logoH + 26 : 44;
    const titleY = top + 92, line1Y = titleY + 66, line2Y = line1Y + 54, line3Y = line2Y + 54;
    const headerBottom = line3Y + 42;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, W, headerBottom);
    ctx.fillStyle = ACCENT;
    ctx.fillRect(0, 0, W, 14);
    ctx.fillRect(0, headerBottom, W, 6);
    if (logo) ctx.drawImage(logo, (W - logoW) / 2, 36, logoW, logoH);
    ctx.textAlign = 'center';
    ctx.fillStyle = INK;
    fitText(ctx, (ad.title.trim() || 'BONO CONTRIBUCIÓN').toUpperCase(), CX, titleY, W - 120, 100);
    ctx.fillStyle = '#6b7280';
    fitText(ctx, 'A beneficio del', CX, line1Y, W - 100, 34, 'normal');
    ctx.fillStyle = INK;
    fitText(ctx, 'Viaje Académico y de Inmersión Tecnológica 2027', CX, line2Y, W - 80, 44);
    fitText(ctx, 'Tech Show London e IBM Quantum Spain', CX, line3Y, W - 80, 44);
    let y = headerBottom + 6 + 54;

    /* Premios: una tarjeta por premio, con su descripción y su foto */
    if (prizes.length) {
      ctx.textAlign = 'left';
      ctx.fillStyle = ACCENT;
      ctx.font = `bold 34px ${FONT}`;
      ctx.fillText(prizes.length > 1 ? 'PREMIOS' : 'PREMIO', M, y + 28);
      y += 56;
      prizes.forEach((prize, i) => {
        const img = pics[prize.id];
        const PHOTO = 190;
        const textX = M + 118;
        const textW = CW - 118 - 28 - (img ? PHOTO + 28 : 0);
        const descLines = prize.desc && prize.desc.trim() ? wrapLines(ctx, prize.desc.trim(), textW, 30) : [];
        const h = Math.max(img ? PHOTO + 40 : 124, 36 + 56 + descLines.length * 40 + 24);
        card(ctx, M, y, CW, h, 24, '#fff', '#e4e2dd');

        ctx.beginPath();
        ctx.arc(M + 58, y + h / 2, 32, 0, Math.PI * 2);
        ctx.fillStyle = INK;
        ctx.fill();
        ctx.textAlign = 'center';
        ctx.fillStyle = '#fff';
        ctx.font = `bold 36px ${FONT}`;
        ctx.fillText(String(i + 1), M + 58, y + h / 2 + 13);

        ctx.textAlign = 'left';
        ctx.fillStyle = INK;
        const nameY = descLines.length ? y + 36 + 40 : y + h / 2 + 15;
        fitText(ctx, prize.name.trim(), textX, nameY, textW, 46);
        ctx.fillStyle = '#4b5563';
        ctx.font = `normal 30px ${FONT}`;
        descLines.forEach((line, k) => ctx.fillText(line, textX, nameY + 44 + k * 40));

        if (img) {
          const px = M + CW - 28 - PHOTO, py = y + (h - PHOTO) / 2;
          card(ctx, px, py, PHOTO, PHOTO, 18, '#f5f4f2', null);
          const k = Math.min((PHOTO - 20) / img.width, (PHOTO - 20) / img.height); // entra entera, sin deformarse
          ctx.drawImage(img, px + (PHOTO - img.width * k) / 2, py + (PHOTO - img.height * k) / 2, img.width * k, img.height * k);
        }
        y += h + 18;
      });
      y += 18;
    }

    /* Precio, promoción y sorteo */
    const promo = ad.promo.trim();
    const draw = ad.draw.trim();
    const labelY = y + 62, priceY = labelY + 90;
    const promoY = priceY + 62;
    const drawY = (promo ? promoY : priceY) + 58;
    const bandH = (draw ? drawY : (promo ? promoY : priceY)) - y + 40;
    card(ctx, M, y, CW, bandH, 24, INK, null);
    ctx.textAlign = 'center';
    ctx.fillStyle = '#fdba74';
    fitText(ctx, 'PRECIO POR NÚMERO', CX, labelY, CW - 60, 30);
    ctx.fillStyle = '#fff';
    fitText(ctx, money(PRICE), CX, priceY, CW - 60, 92);
    if (promo) {
      ctx.fillStyle = '#fb923c';
      fitText(ctx, promo, CX, promoY, CW - 60, 40);
    }
    if (draw) {
      ctx.fillStyle = '#d6d3d1';
      fitText(ctx, draw, CX, drawY, CW - 60, 34, 'normal');
    }
    y += bandH + 56;

    /* Números del alumno */
    ctx.fillStyle = '#6b7280';
    fitText(ctx, 'Números de', CX, y + 30, W - 120, 36, 'normal');
    ctx.fillStyle = INK;
    fitText(ctx, name, CX, y + 100, W - 120, 68);
    const gridTop = y + 140;
    const padX = (W - (COLS * CELL_W + (COLS - 1) * GAP)) / 2;
    numbers.forEach((n, i) => {
      const x = padX + (i % COLS) * (CELL_W + GAP);
      const cy = gridTop + Math.floor(i / COLS) * (CELL_H + GAP);
      const sold = Boolean(state.sales[n]);
      card(ctx, x, cy, CELL_W, CELL_H, 16, sold ? '#e7e5e4' : '#fff', null);
      ctx.lineWidth = 4;
      ctx.strokeStyle = sold ? '#d6d3d1' : INK;
      ctx.stroke();
      ctx.fillStyle = sold ? '#a8a29e' : INK;
      ctx.font = `bold 46px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.fillText(n, x + CELL_W / 2, cy + CELL_H / 2 + 16);
      if (sold) {
        ctx.strokeStyle = '#a8a29e';
        ctx.lineWidth = 4;
        ctx.beginPath();
        ctx.moveTo(x + 22, cy + CELL_H / 2 + 2);
        ctx.lineTo(x + CELL_W - 22, cy + CELL_H / 2 + 2);
        ctx.stroke();
      }
    });
    y = gridTop + Math.ceil(numbers.length / COLS) * (CELL_H + GAP) + 24;

    y += 24;

    /* Contacto para reservar: el teléfono del alumno (o el general, si el alumno no cargó el suyo) */
    ctx.textAlign = 'center';
    const contact = (phone || '').trim() || ad.contact.trim();
    if (contact) {
      ctx.fillStyle = '#6b7280';
      fitText(ctx, `RESERVÁ TU NÚMERO CON ${name.toUpperCase()}`, CX, y + 26, CW, 32);
      card(ctx, M, y + 48, CW, 130, 20, '#e7e5e4', null);
      ctx.fillStyle = INK;
      fitText(ctx, contact, CX, y + 48 + 86, CW - 60, 72);
      y += 48 + 130 + 48;
    } else {
      ctx.fillStyle = '#6b7280';
      fitText(ctx, `Pedile tu número a ${name}`, CX, y + 26, W - 120, 38, 'normal');
      y += 84;
    }

    /* Texto de presentación */
    const about = ad.about.trim();
    if (about) {
      const lines = wrapLines(ctx, about, CW - 64, 30);
      const h = 40 + lines.length * 42 + 22;
      card(ctx, M, y, CW, h, 24, '#fff', '#e4e2dd');
      ctx.textAlign = 'left';
      ctx.fillStyle = '#374151';
      ctx.font = `normal 30px ${FONT}`;
      lines.forEach((line, k) => ctx.fillText(line, M + 32, y + 56 + k * 42));
      y += h;
    }
    return y + 48;
  };

  const probe = document.createElement('canvas');
  probe.width = W;
  probe.height = 7000;
  const H = Math.max(1080, Math.ceil(render(probe.getContext('2d'), 7000)));
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  render(canvas.getContext('2d'), H);
  return canvas;
}

let shareFile = null;
let shareUrl = null;

async function openShare(name, numbers, phone = '') {
  try {
    const canvas = drawShareImage(name, numbers, await loadLogo(), await loadPrizePics(), phone);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
    const slug = name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    shareFile = new File([blob], `bono-${slug || 'alumno'}.png`, { type: 'image/png' });
    if (shareUrl) URL.revokeObjectURL(shareUrl);
    shareUrl = URL.createObjectURL(blob);
    $('share-img').src = shareUrl;
    $('share-title').textContent = 'Imagen de ' + name;
    $('share-send').hidden = !(navigator.canShare && navigator.canShare({ files: [shareFile] }));
    if (!$('share').open) $('share').showModal();
  } catch (err) {
    showError(err);
  }
}

$('share-send').addEventListener('click', async () => {
  try {
    await navigator.share({ files: [shareFile], title: 'Bono Contribución' });
  } catch (err) {
    if (err.name !== 'AbortError') showError(err); // cancelar el menú de compartir no es un error
  }
});
$('share-download').addEventListener('click', () => {
  const a = document.createElement('a');
  a.href = shareUrl;
  a.download = shareFile.name;
  a.click();
});
$('share-close').addEventListener('click', () => $('share').close());

$('btn-assign-csv').addEventListener('click', () => {
  const lines = ['Alumno,Telefono,Numero,Estado'];
  for (const s of Object.values(state.students)) {
    for (const n of s.numbers) {
      const sale = state.sales[n];
      lines.push([s.name, s.phone || '', n, sale ? 'Vendido' : 'Sin vender']
        .map((v) => `"${v.replace(/"/g, '""')}"`).join(','));
    }
  }
  download('bono-asignaciones.csv', '﻿' + lines.join('\r\n'), 'text/csv;charset=utf-8');
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
        proofId,
        ts: now,
        price: PRICE,
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

/* ---------- Configuración (meta y premios) ---------- */

let configTimer;
function saveConfig() {
  clearTimeout(configTimer);
  configTimer = setTimeout(() => {
    setDoc(doc(db, 'config', 'main'), { goal: state.goal, prizes: state.prizes, ad: state.ad }).catch(showError);
  }, 500);
}

const isEditing = (node) => node.contains(document.activeElement);

// Campos de "Datos para la publicidad": clave en state.ad -> id del campo
const AD_FIELDS = { title: 'ad-title', contact: 'ad-contact', draw: 'ad-draw', promo: 'ad-promo', about: 'ad-about' };

function applyConfig(data) {
  state.goal = (data && data.goal) || 0;
  state.prizes = data && Array.isArray(data.prizes) ? data.prizes : defaultPrizes();
  state.ad = { ...defaultAd(), ...((data && data.ad) || {}) };
  if (document.activeElement !== $('goal')) $('goal').value = state.goal;
  for (const [key, id] of Object.entries(AD_FIELDS)) {
    if (document.activeElement !== $(id)) $(id).value = state.ad[key];
  }
  if (!isEditing($('prizes'))) renderPrizes();
}

for (const [key, id] of Object.entries(AD_FIELDS)) {
  $(id).addEventListener('input', () => { state.ad[key] = $(id).value; saveConfig(); });
}
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
    const name = el('input', { type: 'text', className: 'prize-name', value: prize.name, placeholder: 'Nombre del premio' });
    const winner = el('input', { type: 'text', className: 'prize-winner', value: prize.winner, inputMode: 'numeric', maxLength: 4, placeholder: 'Ganador' });
    const result = el('span', { className: 'msg' });
    const remove = el('button', { type: 'button', className: 'danger' }, 'Quitar');

    // Foto del premio: se reduce y se guarda aparte, para no engordar el documento de configuración
    const media = el('div', { className: 'prize-media' });
    const pic = state.prizeImages[prize.id];
    if (pic) media.append(el('img', { className: 'prize-thumb', src: pic, alt: 'Foto de ' + (prize.name || 'premio') }));
    const pick = el('label', { className: 'file-btn' }, pic ? 'Cambiar foto' : 'Agregar foto');
    const file = el('input', { type: 'file', accept: 'image/*' });
    file.hidden = true;
    pick.append(file);
    media.append(pick);
    if (pic) {
      const drop = el('button', { type: 'button', className: 'danger' }, 'Quitar foto');
      drop.addEventListener('click', () => deleteDoc(doc(db, 'prizeImages', prize.id)).catch(showError));
      media.append(drop);
    }
    file.addEventListener('change', async () => {
      const chosen = file.files[0];
      if (!chosen) return;
      if (!chosen.type.startsWith('image/')) return alert('Elegí una foto o una imagen.');
      try {
        await setDoc(doc(db, 'prizeImages', prize.id), { data: await compressImage(chosen) });
        saveConfig(); // asegura que el premio (y su id) queden guardados
      } catch (err) {
        showError(err);
      }
      if (document.activeElement) document.activeElement.blur();
      renderPrizes();
    });

    const showResult = () => {
      if (winner.value.length < 4) return setMsg(result, 'Sin sortear todavía');
      const sale = state.sales[winner.value];
      if (!sale) return setMsg(result, `El ${winner.value} no fue vendido: sin ganador.`, 'error');
      const who = sale.studentId ? ` (vendido por ${studentName(sale.studentId)})` : '';
      setMsg(result, `¡Ganó ${sale.buyer}!${sale.phone ? ' Tel: ' + sale.phone : ''}${who}`, 'ok');
    };
    // Cada guardado vuelve a llegar de Firebase como objetos nuevos: por eso se busca el premio
    // por su id en cada cambio, en vez de usar el objeto que había al dibujar la pantalla.
    const current = () => state.prizes.find((p) => p.id === prize.id);
    name.addEventListener('input', () => {
      const p = current();
      if (p) { p.name = name.value; saveConfig(); }
    });
    winner.addEventListener('input', () => {
      winner.value = winner.value.replace(/\D/g, '');
      const p = current();
      if (p) { p.winner = winner.value; saveConfig(); }
      showResult();
    });
    remove.addEventListener('click', () => {
      deleteDoc(doc(db, 'prizeImages', prize.id)).catch(() => {});
      state.prizes = state.prizes.filter((p) => p.id !== prize.id);
      saveConfig();
      renderPrizes();
    });
    const desc = el('input', { type: 'text', className: 'prize-desc', value: prize.desc || '',
      placeholder: 'Descripción (ej: Asus Vivobook 15.6", Core i3, 8 GB RAM, 128 GB SSD)' });
    desc.addEventListener('input', () => {
      const p = current();
      if (p) { p.desc = desc.value; saveConfig(); }
    });
    row.append(el('span', { className: 'prize-n' }, String(i + 1) + '°'), name, winner, remove, desc, media, result);
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
    if (sale) btn.classList.add('sold');
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
  const rows = Object.keys(state.sales).sort().filter((num) => {
    const s = state.sales[num];
    return !text || [num, s.buyer, studentName(s.studentId)].join(' ').toLowerCase().includes(text);
  });

  const body = $('sales-body');
  body.textContent = '';
  for (const num of rows.slice(0, MAX_ROWS)) {
    const s = state.sales[num];
    const tr = el('tr');
    // data-label: en el celular cada fila se muestra como una tarjeta con su título
    [num, s.buyer, s.phone || '', studentName(s.studentId), fmtDate(s.ts)].forEach((v, i) => {
      const td = el('td', {}, v);
      td.dataset.label = ['Número', 'Comprador/a', 'Contacto', 'Vendedor/a', 'Fecha'][i];
      tr.append(td);
    });
    const tdState = el('td');
    tdState.dataset.label = 'Comprobante';
    tdState.append(el('span', { className: 'badge ' + (s.proofId ? 'paid' : 'pending') }, s.proofId ? 'Con comprobante' : 'Sin comprobante'));
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
    ['Precio', money(priceOf(s))],
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
    lines.push([num, s.buyer, s.phone, studentName(s.studentId), fmtDate(s.ts), priceOf(s), s.proofId ? 'Si' : 'No', s.by]
      .map(quote).join(','));
  }
  download('bono-ventas.csv', '﻿' + lines.join('\r\n'), 'text/csv;charset=utf-8');
});

$('btn-backup').addEventListener('click', async () => {
  try {
    const data = {
      goal: state.goal, prizes: state.prizes, ad: state.ad,
      students: state.students, sales: state.sales, proofs: await allProofs(),
    };
    download('bono-respaldo.json', JSON.stringify(data), 'application/json');
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
      goal: data.goal || 0, prizes: data.prizes || defaultPrizes(), ad: { ...defaultAd(), ...(data.ad || {}) },
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
    watch('prizeImages', (data) => {
      state.prizeImages = Object.fromEntries(Object.entries(data).map(([id, d]) => [id, d.data]));
    }),
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
