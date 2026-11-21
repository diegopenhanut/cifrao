#!/usr/bin/env node
// Uso: node cifras.js [links.txt] [cifras.json]
//      node cifras.js --limpar [cifras.json]   (só limpa o arquivo, sem baixar nada)
// Requer Node 18+ (fetch nativo). Sem dependências.
const fs = require('fs');

const args = process.argv.slice(2);
const LIMPAR = args.includes('--limpar');
const pos = args.filter((a) => !a.startsWith('--'));
const LINKS = LIMPAR ? null : pos[0] || 'links.txt';
const OUT = (LIMPAR ? pos[0] : pos[1]) || 'cifras.json';
const PAUSA_MS = 4000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Caracteres de largura zero (U+200B..U+200D, U+FEFF) vêm no começo das linhas e
// atrapalham a identificação das linhas de acordes.
const LARGURA_ZERO = /[​-‍﻿]/g;

function limparArquivo() {
  const dados = JSON.parse(fs.readFileSync(OUT, 'utf8'));
  if (!Array.isArray(dados.songs)) throw new Error(`${OUT} não tem a lista "songs"`);
  let musicas = 0;
  let chars = 0;
  for (const s of dados.songs) {
    const novo = String(s.text || '').replace(LARGURA_ZERO, '');
    if (novo !== s.text) {
      chars += s.text.length - novo.length;
      musicas++;
      s.text = novo;
    }
  }
  if (!musicas) {
    console.log(`${OUT} já está limpo (${dados.songs.length} músicas).`);
    return;
  }
  fs.writeFileSync(OUT, JSON.stringify(dados, null, 2) + '\n');
  console.log(`${musicas} de ${dados.songs.length} música(s) alterada(s), ${chars} caractere(s) removido(s) em ${OUT}.`);
}

const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodificar(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cod = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cod) ? String.fromCodePoint(cod) : m;
    }
    const v = ENTIDADES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

const semTags = (s) => s.replace(/<[^>]*>/g, '');

function extrair(html) {
  // Texto da cifra: primeiro <pre>
  const pre = html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/i);
  if (!pre) throw new Error('bloco <pre> não encontrado');
  const text = decodificar(semTags(pre[1].replace(/<br\s*\/?>/gi, '\n')))
    .replace(LARGURA_ZERO, '')
    .replace(/\r\n?/g, '\n')
    .replace(/^\n+|\s+$/g, '');
  if (!text) throw new Error('cifra vazia');

  // Título e artista
  const h1 = html.match(/<h1[^>]*class="[^"]*t1[^"]*"[^>]*>([\s\S]*?)<\/h1>/i);
  const h2 = html.match(/<h2[^>]*class="[^"]*t3[^"]*"[^>]*>([\s\S]*?)<\/h2>/i);
  let title = h1 && decodificar(semTags(h1[1])).trim();
  let artist = h2 && decodificar(semTags(h2[1])).trim();

  if (!title || !artist) {
    // Fallback: <title> costuma ser "Música - Artista - Nome do site"
    const t = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const partes = t ? decodificar(t[1]).split(' - ').map((p) => p.trim()) : [];
    title = title || partes[0] || '';
    artist = artist || partes[1] || '';
  }
  if (!title) throw new Error('título não encontrado');
  return { title, artist, text };
}

function idDe(url) {
  return new URL(url).pathname.replace(/\.html$/i, '').split('/').filter(Boolean).join('-').toLowerCase();
}

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) cifras-script',
  'Accept-Language': 'pt-BR,pt;q=0.9',
};

// Página de repertório: a lista vem num JSON embutido (Next.js), em "initialSongbook".
function musicasDoRepertorio(html, origem) {
  const t = html.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  const ini = t.indexOf('"initialSongbook":');
  if (ini < 0) throw new Error('lista do repertório não encontrada na página');
  const abre = t.indexOf('{', ini);
  let nivel = 0, dentro = false, fim = -1;
  for (let i = abre; i < t.length; i++) {
    const c = t[i];
    if (dentro) {
      if (c === '\\') i++;
      else if (c === '"') dentro = false;
    } else if (c === '"') dentro = true;
    else if (c === '{') nivel++;
    else if (c === '}' && --nivel === 0) { fim = i; break; }
  }
  if (fim < 0) throw new Error('JSON do repertório incompleto');
  const livro = JSON.parse(t.slice(abre, fim + 1));
  if (!Array.isArray(livro.items) || !livro.items.length) throw new Error('repertório vazio');
  if (livro.totalItems && livro.totalItems !== livro.items.length) {
    console.warn(`AVISO: o repertório tem ${livro.totalItems} músicas, mas só ${livro.items.length} vieram na página.`);
  }
  return livro.items.map(({ version: v }) => {
    const label = v.label && v.label.slug !== 'principal' ? `${v.label.slug}.html` : '';
    return `${origem}/${v.artist.slug}/${v.song.slug}/${label}`;
  });
}

async function expandir(linhas) {
  const urls = [];
  for (const l of linhas) {
    if (!/\/repertorio\//.test(l)) { urls.push(l); continue; }
    try {
      const res = await fetch(l, { headers: HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const lista = musicasDoRepertorio(await res.text(), new URL(l).origin);
      console.log(`Repertório ${l}: ${lista.length} música(s)`);
      urls.push(...lista);
    } catch (e) {
      console.warn(`FALHOU repertório: ${l} (${e.message})`);
      process.exitCode = 1;
    }
    await sleep(PAUSA_MS);
  }
  return [...new Set(urls)];
}

async function main() {
  const urls = await expandir(
    fs
      .readFileSync(LINKS, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
  );

  // Cifras já salvas são mantidas e não são baixadas de novo.
  let songs = [];
  try {
    songs = JSON.parse(fs.readFileSync(OUT, 'utf8')).songs || [];
  } catch {}
  const existentes = new Set(songs.map((s) => s.id));
  const salvar = () => fs.writeFileSync(OUT, JSON.stringify({ songs }, null, 2) + '\n');
  const falhas = [];
  let baixou = false;
  let puladas = 0;

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const n = `[${i + 1}/${urls.length}]`;
    if (existentes.has(idDe(url))) {
      puladas++;
      console.log(`${n} JÁ EXISTE: ${idDe(url)}`);
      continue;
    }
    if (baixou) await sleep(PAUSA_MS);
    baixou = true;
    try {
      const res = await fetch(url, { headers: HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { title, artist, text } = extrair(await res.text());
      songs.push({
        id: idDe(url),
        title,
        artist,
        text,
        transpose: 0,
        speed: 2,
        font: 15,
        updated: new Date().toISOString(),
      });
      existentes.add(idDe(url));
      salvar();
      console.log(`${n} OK: ${artist} - ${title}`);
    } catch (e) {
      falhas.push(url);
      console.warn(`${n} FALHOU: ${url} (${e.message})`);
    }
  }

  salvar();
  console.log(`\n${songs.length} cifra(s) em ${OUT} (${puladas} já existiam).`);
  if (falhas.length) {
    console.warn(`ATENÇÃO: ${falhas.length} link(s) falharam:`);
    falhas.forEach((u) => console.warn(`  - ${u}`));
    process.exitCode = 1;
  }
}

(LIMPAR ? Promise.resolve().then(limparArquivo) : main()).catch((e) => {
  console.error(e.message);
  process.exit(1);
});
