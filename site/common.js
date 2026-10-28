import { SUPABASE_URL, SUPABASE_KEY, DEFAULT_POLL } from './config.js';

export const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storageKey: 'live-poll-auth' },
});

export const PALETTE = ['#5769e7', '#ff6b6b', '#2bb673', '#ffb547', '#9b6bff', '#25b5e8', '#f06292', '#8bc34a', '#ff8a3d', '#4db6ac'];

export function pollCode() {
  const code = new URLSearchParams(location.search).get('p');
  return (code || DEFAULT_POLL).trim().toLowerCase();
}

export function voteUrl(code) {
  const url = new URL('./', location.href);
  if (code !== DEFAULT_POLL) url.searchParams.set('p', code);
  return url.href;
}

export function displayUrl(href) {
  return href.replace(/^https?:\/\//, '').replace(/\/$/, '');
}

export function qrDataUrl(text, cellSize = 8, margin = 2) {
  const qr = window.qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createDataURL(cellSize, margin);
}

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

export function $(selector, root = document) {
  return root.querySelector(selector);
}

export async function rpc(name, args) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw error;
  return data;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function ratingRange(options) {
  const min = Number.isInteger(options?.min) ? options.min : 1;
  const max = Number.isInteger(options?.max) ? options.max : 5;
  return { min, max, minLabel: options?.min_label || '', maxLabel: options?.max_label || '' };
}

export function toast(message, kind = 'info') {
  let box = $('#toast');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toast';
    document.body.appendChild(box);
  }
  box.textContent = message;
  box.className = `show ${kind}`;
  clearTimeout(box._timer);
  box._timer = setTimeout(() => (box.className = ''), 3500);
}
