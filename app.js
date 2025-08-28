/* app.js - Updated to ensure audio plays from list, storybooks as gallery,
   mobile-friendly, main-screen player full features, visualizer init on gesture.
*/

/* -------- CONFIG -------- */
const RSS_FEED = 'https://anchor.fm/s/2d3bd0d0/podcast/rss';
const DB_NAME = 'african_stories_db_v3';
const DB_STORE_AUDIO = 'audio_files_v3';
const PRIMARY_COLOR = '#FF9800';
const CORS_PROXIES = [
  'https://api.allorigins.win/raw?url=',
  'https://thingproxy.freeboard.io/fetch/',
  'https://api.allorigins.cf/raw?url='
];

/* -------- Helpers -------- */
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
function stripHtml(html){ if(!html) return ''; const tmp = document.createElement('div'); tmp.innerHTML = html; return tmp.textContent || tmp.innerText || ''; }
function formatDate(dStr){ try { const d = new Date(dStr); return d.toLocaleDateString(); } catch(e){ return dStr; } }
function formatTime(t){ if(!t || isNaN(t)) return '0:00'; const mins = Math.floor(t/60); const secs = Math.floor(t%60).toString().padStart(2,'0'); return `${mins}:${secs}`; }

/* -------- IndexedDB for audio blobs ---------- */
const IDB = {
  db: null,
  async init(){ if(this.db) return; return new Promise((res,rej)=>{ const req = indexedDB.open(DB_NAME,1); req.onupgradeneeded = e => { const db = e.target.result; if(!db.objectStoreNames.contains(DB_STORE_AUDIO)) db.createObjectStore(DB_STORE_AUDIO, { keyPath:'id' }); }; req.onsuccess = e => { this.db = e.target.result; res(); }; req.onerror = e => rej(e); }); },
  async putAudio(id, blob){ await this.init(); return new Promise((res,rej)=>{ const tx = this.db.transaction(DB_STORE_AUDIO,'readwrite'); tx.objectStore(DB_STORE_AUDIO).put({id,blob}); tx.oncomplete = ()=> res(true); tx.onerror = e => rej(e); }); },
  async getAudio(id){ await this.init(); return new Promise((res,rej)=>{ const tx = this.db.transaction(DB_STORE_AUDIO,'readonly'); const req = tx.objectStore(DB_STORE_AUDIO).get(id); req.onsuccess = ()=> res(req.result ? req.result.blob : null); req.onerror = e => rej(e); }); },
  async deleteAudio(id){ await this.init(); return new Promise((res,rej)=>{ const tx = this.db.transaction(DB_STORE_AUDIO,'readwrite'); tx.objectStore(DB_STORE_AUDIO).delete(id); tx.oncomplete = ()=> res(true); tx.onerror = e => rej(e); }); },
  async listAudioIds(){ await this.init(); return new Promise((res,rej)=>{ const tx = this.db.transaction(DB_STORE_AUDIO,'readonly'); const req = tx.objectStore(DB_STORE_AUDIO).getAllKeys(); req.onsuccess = ()=> res(req.result || []); req.onerror = e => rej(e); }); }
};

/* -------- App state ---------- */
const state = {
  episodes: [],
  playingIndex: -1,
  favorites: new Set(JSON.parse(localStorage.getItem('favorites') || '[]')),
  listeningHistory: JSON.parse(localStorage.getItem('listeningHistory') || '[]'),
  downloadsMeta: JSON.parse(localStorage.getItem('downloadsMeta') || '{}'),
  downloadsSet: new Set(),
  playlist: [],
  storybooks: [
    {id:'s1', title:'Anansi and the Moss-Covered Rock', content:'Once upon a time Anansi discovered a mysterious moss-covered rock...','thumb':'assets/images/story1.jpg'},
    {id:'s2', title:'The Tortoise and the Birds', content:'A tortoise longed to fly with the birds...', 'thumb':'assets/images/story2.jpg'},
    {id:'s3', title:'The Lion\'s Whisker', content:'A brave mother seeks a lion\'s whisker...', 'thumb':'assets/images/story3.jpg'}
  ],
  audioInitializedByUserGesture: false
};

/* -------- CORS / fetch helper ---------- */
async function fetchWithCors(url, type='text'){
  try {
    const r = await fetch(url, { mode: 'cors' });
    if(!r.ok) throw new Error('Network error ' + r.status);
    if(type==='text') return await r.text();
    if(type==='blob') return await r.blob();
    return r;
  } catch(err){
    console.warn('Direct fetch failed; trying proxies', err);
    for(const p of CORS_PROXIES){
      try {
        const prox = p + encodeURIComponent(url);
        const r2 = await fetch(prox);
        if(!r2.ok) throw new Error('Proxy failed ' + r2.status);
        if(type==='text') return await r2.text();
        if(type==='blob') return await r2.blob();
        return r2;
      } catch(e){
        console.warn('Proxy failed:', p, e);
      }
    }
    throw new Error('All fetch attempts failed (CORS).');
  }
}

/* -------- RSS parse ---------- */
async function fetchRSS(){
  try {
    const xmlText = await fetchWithCors(RSS_FEED,'text');
    const parser = new DOMParser();
    const xml = parser.parseFromString(xmlText,'application/xml');
    const items = Array.from(xml.querySelectorAll('item'));
    const episodes = items.map(item=>{
      const title = stripHtml(item.querySelector('title')?.textContent || '');
      const rawDesc = item.querySelector('description')?.textContent || '';
      const description = stripHtml(rawDesc);
      const pubDate = item.querySelector('pubDate')?.textContent || '';
      const enclosure = item.querySelector('enclosure');
      const audioUrl = enclosure?.getAttribute('url') || item.querySelector('media\\:content')?.getAttribute('url') || '';
      const itunesImage = item.querySelector('itunes\\:image')?.getAttribute('href') || xml.querySelector('image > url')?.textContent || null;
      const id = audioUrl || (title + pubDate);
      return { id, title, description, pubDate, audioUrl, imageUrl: itunesImage };
    });
    episodes.sort((a,b)=>new Date(b.pubDate)-new Date(a.pubDate));
    state.episodes = episodes;
    state.playlist = episodes.map(e=>e.id);
    localStorage.setItem('cachedEpisodes', JSON.stringify(episodes));
    return episodes;
  } catch(e){
    console.warn('RSS failed, fallback to cache', e);
    const cached = localStorage.getItem('cachedEpisodes');
    if(cached){ state.episodes = JSON.parse(cached); state.playlist = state.episodes.map(e=>e.id); return state.episodes; }
    return [];
  }
}

/* -------- Render episodes list with inline play button ---------- */
function renderEpisodes(list=state.episodes){
  const container = $('#episodeList'); container.innerHTML = '';
  if(list.length===0){ container.innerHTML = '<div class="muted">No episodes available.</div>'; return; }
  list.forEach((ep, idx)=>{
    const row = document.createElement('div'); row.className='episode-item card';
    const img = document.createElement('img'); img.src = ep.imageUrl || 'assets/images/placeholder-baobab.png'; img.alt = ep.title; img.loading='lazy';
    const meta = document.createElement('div'); meta.className='episode-meta';
    const title = document.createElement('h4'); title.textContent = ep.title;
    const date = document.createElement('div'); date.className='muted small'; date.textContent = formatDate(ep.pubDate);
    const desc = document.createElement('p'); desc.textContent = ep.description || '';
    // action row (play inline, read more, fav, download)
    const actions = document.createElement('div'); actions.style.marginTop='8px';
    const playBtn = document.createElement('button'); playBtn.className='big-btn'; playBtn.textContent='Play';
    // Play from list WITHOUT opening details
    playBtn.onclick = async (ev) => { ev.stopPropagation(); // ensure user gesture
      await userGestureInit(); // init audioCtx if needed
      await playEpisodeNow(idx);
    };
    // Read more opens details
    const readBtn = document.createElement('button'); readBtn.className='control'; readBtn.textContent='Read more';
    readBtn.onclick = (ev) => { ev.stopPropagation(); openStoryDetail(ep); };
    const favBtn = document.createElement('button'); favBtn.className='icon-btn'; favBtn.innerHTML = state.favorites.has(ep.id)?'❤️':'♡';
    favBtn.onclick = (ev) => { ev.stopPropagation(); toggleFavorite(ep.id); favBtn.innerHTML = state.favorites.has(ep.id)?'❤️':'♡'; renderFavorites(); };
    const dlBtn = document.createElement('button'); dlBtn.className='icon-btn'; dlBtn.textContent = state.downloadsMeta[ep.id] ? '📥' : '⬇';
    dlBtn.onclick = async (ev) => { ev.stopPropagation(); await handleDownload(ep, dlBtn); renderDownloads(); };

    actions.append(playBtn, readBtn, favBtn, dlBtn);
    meta.append(title, date, desc, actions);
    row.append(img, meta);
    // tap on row also plays (user expecting)
    row.onclick = async () => { await userGestureInit(); await playEpisodeNow(idx); }
    container.appendChild(row);
  });
}

/* -------- Favorites ---------- */
function toggleFavorite(id){
  if(state.favorites.has(id)) state.favorites.delete(id);
  else state.favorites.add(id);
  localStorage.setItem('favorites', JSON.stringify(Array.from(state.favorites)));
}
function renderFavorites(){
  const container = $('#favoritesList'); container.innerHTML = '';
  const favs = state.episodes.filter(e=>state.favorites.has(e.id));
  if(favs.length===0){ container.innerHTML='<div class="muted">No favorites yet.</div>'; return; }
  favs.forEach(ep=>{
    const row = document.createElement('div'); row.className='episode-item card';
    row.innerHTML = `<img src="${ep.imageUrl || 'assets/images/placeholder-baobab.png'}" width="96" height="96" alt="thumb"><div class="episode-meta"><h4>${ep.title}</h4><div class="muted small">${formatDate(ep.pubDate)}</div><p>${ep.description}</p></div>`;
    row.onclick = ()=> openPlayerById(ep.id);
    container.appendChild(row);
  });
}

/* -------- Audio player core ---------- */
const audio = $('#audio');
let audioCtx = null, analyser = null, sourceNode = null, rafId = null;

async function userGestureInit(){
  // Ensure we initialize AudioContext and visualizer on first user gesture
  if(state.audioInitializedByUserGesture) return;
  state.audioInitializedByUserGesture = true;
  try {
    audioCtx = new (window.AudioContext||window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    sourceNode = audioCtx.createMediaElementSource(audio);
    sourceNode.connect(analyser);
    analyser.connect(audioCtx.destination);
    analyser.fftSize = 128;
    visualize();
  } catch(e){
    console.warn('Audio visualizer unavailable', e);
  }
}

/* Visualizer */
function visualize(){
  const canvas = $('#visualizer'); if(!canvas || !analyser) return;
  const ctx = canvas.getContext('2d');
  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  function draw(){
    rafId = requestAnimationFrame(draw);
    analyser.getByteFrequencyData(dataArray);
    ctx.fillStyle = '#fff'; ctx.fillRect(0,0,canvas.width,canvas.height);
    const barWidth = (canvas.width / bufferLength) * 1.1;
    let x = 0;
    for(let i=0;i<bufferLength;i++){
      const v = dataArray[i];
      const h = (v/255) * canvas.height;
      ctx.fillStyle = PRIMARY_COLOR;
      ctx.fillRect(x, canvas.height - h, barWidth, h);
      x += barWidth + 1;
    }
  }
  draw();
}
function stopVisualizer(){ if(rafId){ cancelAnimationFrame(rafId); rafId=null; } }

/* Play episode now (from list) */
async function playEpisodeNow(index){
  if(index < 0 || index >= state.episodes.length) return;
  state.playingIndex = index;
  const ep = state.episodes[index];
  // Update mini UI immediately
  $('#miniTitle').textContent = ep.title;
  $('#miniSub').textContent = 'Loading...';
  // Try IDB first
  const blob = await IDB.getAudio(ep.id);
  if(blob){
    audio.src = URL.createObjectURL(blob);
    try{ await audio.play(); } catch(e){ console.warn('Play blocked', e); }
  } else {
    // stream from remote URL (no fetch) - better for large files
    if(ep.audioUrl){
      audio.src = ep.audioUrl;
      try{ await audio.play(); } catch(e){
        console.warn('Play blocked (autoplay policy) - ensure this is triggered by user gesture', e);
      }
    } else {
      alert('No audio URL available for this episode.');
      return;
    }
  }
  // Update full player UI
  $('#playerThumb').src = ep.imageUrl || 'assets/images/placeholder-baobab.png';
  $('#playerTitle').textContent = ep.title;
  $('#playerDate').textContent = formatDate(ep.pubDate);
  $('#playerDesc').textContent = ep.description;
  $('#favBtn').textContent = state.favorites.has(ep.id) ? '❤️' : '♡';
  $('#downloadBtn').textContent = state.downloadsMeta[ep.id] ? '📥' : '⬇';
  // show mini player as playing
  $('#miniPlay').textContent = '⏸'; $('#miniSub').textContent = 'Playing';
  showScreen('home'); // keep user on home view (per request, allow play without opening detail)
  // Setup player bindings and MediaSession
  setupPlayerUI();
  setupMediaSession(ep);
  // push to listening history
  addListeningHistory(ep.id);
}

/* Open player by ID / index (detail view) */
function openPlayerById(id){ const idx = state.episodes.findIndex(e=>e.id===id); if(idx>=0) openPlayerByIndex(idx); }
async function openPlayerByIndex(idx){ if(idx<0||idx>=state.episodes.length) return; state.playingIndex = idx; const ep = state.episodes[idx]; // same as playEpisodeNow but also show full player view
  await playEpisodeNow(idx);
  showScreen('player');
}

/* Setup player controls & events */
function setupPlayerUI(){
  $('#playPause').onclick = ()=> { if(audio.paused) audio.play(); else audio.pause(); };
  $('#miniPlay').onclick = ()=> { if(audio.paused) audio.play(); else audio.pause(); };
  $('#back15').onclick = ()=> { audio.currentTime = Math.max(0, audio.currentTime - 15); };
  $('#fwd15').onclick = ()=> { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 15); };
  $('#prevBtn').onclick = ()=> playPrev();
  $('#nextBtn').onclick = ()=> playNext();
  $('#miniPrev').onclick = ()=> playPrev();
  $('#miniNext').onclick = ()=> playNext();

  $('#speedSelect').onchange = (e)=> audio.playbackRate = Number(e.target.value);
  $('#volume').oninput = (e)=> audio.volume = Number(e.target.value);

  const seek = $('#seek');
  seek.oninput = (e) => { if(audio.duration) audio.currentTime = (seek.value/100) * audio.duration; };
  audio.ontimeupdate = ()=> { if(audio.duration){ const pct = (audio.currentTime / audio.duration) * 100; $('#seek').value = pct; $('#curTime').textContent = formatTime(audio.currentTime); $('#durTime').textContent = formatTime(audio.duration); } };
  audio.onplay = ()=> { $('#playPause').textContent='⏸'; $('#miniPlay').textContent='⏸'; $('#miniSub').textContent = 'Playing'; };
  audio.onpause = ()=> { $('#playPause').textContent='▶'; $('#miniPlay').textContent='▶'; $('#miniSub').textContent = 'Paused'; };
  audio.onended = ()=> { $('#playPause').textContent='▶'; $('#miniPlay').textContent='▶'; playNext(); };

  // fav/download handlers (full player)
  $('#favBtn').onclick = ()=> { const ep = state.episodes[state.playingIndex]; if(!ep) return; toggleFavorite(ep.id); $('#favBtn').textContent = state.favorites.has(ep.id) ? '❤️' : '♡'; renderFavorites(); };
  $('#downloadBtn').onclick = async ()=> { const ep = state.episodes[state.playingIndex]; if(!ep) return; await handleDownload(ep, $('#downloadBtn')); renderDownloads(); };
}

/* Media Session integration */
function setupMediaSession(ep){
  if('mediaSession' in navigator){
    navigator.mediaSession.metadata = new MediaMetadata({ title: ep.title, artist: 'African Children\'s Stories', album: 'Podcast', artwork: [{ src: ep.imageUrl || 'assets/icons/icon-192.png', sizes:'192x192', type:'image/png' }]});
    navigator.mediaSession.setActionHandler('play', ()=> audio.play());
    navigator.mediaSession.setActionHandler('pause', ()=> audio.pause());
    navigator.mediaSession.setActionHandler('seekbackward', ()=> audio.currentTime = Math.max(0, audio.currentTime - 15));
    navigator.mediaSession.setActionHandler('seekforward', ()=> audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 15));
    navigator.mediaSession.setActionHandler('previoustrack', ()=> playPrev());
    navigator.mediaSession.setActionHandler('nexttrack', ()=> playNext());
  }
}

/* Next/Prev functions using state.playlist and playingIndex */
function playNext(){ if(state.episodes.length === 0) return; const next = (state.playingIndex + 1) % state.episodes.length; openPlayerByIndex(next); }
function playPrev(){ if(state.episodes.length === 0) return; const prev = (state.playingIndex - 1 + state.episodes.length) % state.episodes.length; openPlayerByIndex(prev); }

/* --------- Download handling (IDB + localStorage metadata) ---------- */
async function handleDownload(ep, btnElement){
  if(state.downloadsMeta[ep.id]){
    if(!confirm('Remove downloaded episode?')) return;
    await IDB.deleteAudio(ep.id);
    delete state.downloadsMeta[ep.id];
    localStorage.setItem('downloadsMeta', JSON.stringify(state.downloadsMeta));
    btnElement.textContent = '⬇';
    await updateDownloadSet();
    return;
  }
  try {
    btnElement.textContent = '...';
    const blob = await fetchWithCors(ep.audioUrl,'blob');
    await IDB.putAudio(ep.id, blob);
    const sizeMB = (blob.size / (1024*1024)).toFixed(2);
    state.downloadsMeta[ep.id] = { title: ep.title, when: Date.now(), sizeMB };
    localStorage.setItem('downloadsMeta', JSON.stringify(state.downloadsMeta));
    btnElement.textContent = '📥';
    await updateDownloadSet();
    alert('Downloaded for offline playback.');
  } catch(e){
    console.error('Download failed', e);
    alert('Download failed due to CORS or network. The app tried proxies. For reliable downloads, host a small proxy or host the app on a domain allowed by the RSS/audio host.');
    btnElement.textContent = '⬇';
  }
}
async function updateDownloadSet(){ const ids = await IDB.listAudioIds(); state.downloadsSet = new Set(ids); }

/* --------- Render downloads ---------- */
async function renderDownloads(){ const container = $('#downloadsList'); container.innerHTML=''; const ids = await IDB.listAudioIds(); if(ids.length===0){ container.innerHTML='<div class="muted">No downloads.</div>'; return; } ids.forEach(id=>{ const meta = state.downloadsMeta[id] || {}; const ep = state.episodes.find(e=>e.id===id) || {title:meta.title||id,pubDate:''}; const row = document.createElement('div'); row.className='episode-item card'; row.innerHTML = `<div class="episode-meta"><h4>${ep.title}</h4><div class="muted small">${formatDate(ep.pubDate)}</div><p>${meta.sizeMB ? meta.sizeMB + ' MB' : ''}</p></div>`; const playBtn = document.createElement('button'); playBtn.className='big-btn'; playBtn.textContent='Play'; playBtn.onclick = async ()=> { const blob = await IDB.getAudio(id); if(blob){ audio.src = URL.createObjectURL(blob); await audio.play(); showScreen('player'); $('#playerTitle').textContent = ep.title; } }; const delBtn = document.createElement('button'); delBtn.className='icon-btn'; delBtn.textContent='Delete'; delBtn.onclick = async ()=> { if(confirm('Delete download?')){ await IDB.deleteAudio(id); delete state.downloadsMeta[id]; localStorage.setItem('downloadsMeta', JSON.stringify(state.downloadsMeta)); renderDownloads(); } }; row.append(playBtn, delBtn); container.appendChild(row); }); }

/* --------- Recommendations simple ---------- */
function renderRecommendations(){ const recWrap = $('#recommendations'); const recList = $('#recList'); recList.innerHTML=''; if(!state.listeningHistory || state.listeningHistory.length===0){ recWrap.classList.add('hidden'); return; } const recentIds = new Set(state.listeningHistory.slice(0,10).map(h=>h.id)); const recs = state.episodes.filter(e=>!recentIds.has(e.id)).slice(0,4); if(recs.length===0){ recWrap.classList.add('hidden'); return; } recWrap.classList.remove('hidden'); recs.forEach(ep=>{ const r = document.createElement('div'); r.className='episode-item card'; r.innerHTML = `<img src="${ep.imageUrl || 'assets/images/placeholder-baobab.png'}" width="96" height="96"><div class="episode-meta"><h4>${ep.title}</h4><div class="muted small">${formatDate(ep.pubDate)}</div><p>${ep.description}</p></div>`; r.onclick = ()=> openPlayerById(ep.id); recList.appendChild(r); }); }

/* --------- Storybooks gallery rendering --------- */
function renderStorybooksGallery(){ const g = $('#storybookGallery'); g.innerHTML=''; state.storybooks.forEach(s=>{ const it = document.createElement('div'); it.className='gallery-item'; it.innerHTML = `<img src="${s.thumb || 'assets/images/placeholder-baobab.png'}" alt="${s.title}"><h4>${s.title}</h4><button class="big-btn read-more">Read more</button>`; it.querySelector('.read-more').onclick = ()=> openStoryDetail(s); g.appendChild(it); }); }

/* Open story detail (Read more) */
function openStoryDetail(s){ showScreen('storyDetail'); $('#storyTitle').textContent = s.title; $('#storyContent').textContent = s.content; $('#ttsBtn').onclick = ()=> speakText(s.content); $('#quizBtn').onclick = ()=> openQuizForStory(s); $('#drawBtn').onclick = ()=> openDrawModal(s.id); }

/* --------- TTS ---------- */
let synth = window.speechSynthesis;
function speakText(text){ if(!synth){ alert('Text-to-speech not supported'); return; } synth.cancel(); const u = new SpeechSynthesisUtterance(text); u.lang = 'en-US'; u.rate = 0.95; synth.speak(u); }

/* --------- Quiz ---------- */
function openQuizForStory(story){ showScreen('quiz'); const quizInner = $('#quizInner'); quizInner.innerHTML=''; const questions = [ {q:'What was the lesson?', opts:['Be kind','Be greedy','Be loud'], a:'Be kind'}, {q:'Who appears?', opts:['Anansi','Robot','Dragon'], a:'Anansi'} ]; let idx=0,score=0; function renderQ(){ if(idx>=questions.length){ quizInner.innerHTML = `<h3>Score ${score}/${questions.length}</h3><button class="big-btn" onclick="showScreen('storyDetail')">Back</button>`; return; } const Q = questions[idx]; quizInner.innerHTML = `<h3>${Q.q}</h3>`; Q.opts.forEach(opt=>{ const b = document.createElement('button'); b.className='big-btn'; b.style.display='block'; b.style.width='100%'; b.textContent = opt; b.onclick = ()=> { if(opt===Q.a) score++; idx++; renderQ(); }; quizInner.appendChild(b); }); } renderQ(); }

/* --------- Matching game (same as before) ---------- */
const MATCH_PAIRS = [ {left:'Elephant', right:'Savannah'}, {left:'Camel', right:'Desert'}, {left:'Crocodile', right:'River'} ];
function setupMatchingGame(){ const board = $('#matchBoard'); board.innerHTML=''; const lefts = MATCH_PAIRS.map(p=>p.left).sort(()=>Math.random()-0.5); const rights = MATCH_PAIRS.map(p=>p.right).sort(()=>Math.random()-0.5); lefts.forEach(l=>{ const d = document.createElement('div'); d.className='card'; d.style.padding='10px'; d.style.minWidth='120px'; d.textContent = l; d.dataset.left = l; d.onclick = ()=> selectLeft(l,d); board.appendChild(d); }); rights.forEach(r=>{ const d = document.createElement('div'); d.className='card'; d.style.padding='10px'; d.style.minWidth='120px'; d.textContent = r; d.dataset.right = r; d.onclick = ()=> attemptMatch(r,d); board.appendChild(d); }); window.matchSelection = {left:null,leftEl:null,score:0}; $('#startMatch').onclick = ()=> { window.matchSelection.score = 0; $('#matchScore').textContent='Score: 0'; setupMatchingGame(); }; }
function selectLeft(val, elNode){ window.matchSelection.left=val; window.matchSelection.leftEl=elNode; elNode.style.outline = `3px solid ${PRIMARY_COLOR}`; }
function attemptMatch(rightVal, elNode){ if(!window.matchSelection.left){ alert('Select an animal first.'); return; } const found = MATCH_PAIRS.find(p=>p.left===window.matchSelection.left && p.right===rightVal); if(found){ window.matchSelection.score++; $('#matchScore').textContent = `Score: ${window.matchSelection.score}`; window.matchSelection.leftEl.style.opacity='0.4'; elNode.style.opacity='0.4'; } else alert('Try again.'); if(window.matchSelection.leftEl) window.matchSelection.leftEl.style.outline=''; window.matchSelection.left=null; }

/* --------- Drawing & parent gate ---------- */
function openDrawModal(storyId){ $('#drawModal').classList.remove('hidden'); const canvas = $('#drawCanvas'); const ctx = canvas.getContext('2d'); ctx.fillStyle='#fff'; ctx.fillRect(0,0,canvas.width,canvas.height); ctx.strokeStyle='#000'; ctx.lineWidth=3; ctx.lineCap='round'; let drawing=false; canvas.onpointerdown = e=>{ drawing=true; ctx.beginPath(); ctx.moveTo(e.offsetX,e.offsetY); }; canvas.onpointermove = e=>{ if(drawing){ ctx.lineTo(e.offsetX,e.offsetY); ctx.stroke(); } }; canvas.onpointerup = ()=> drawing=false; $('#saveDrawing').onclick = ()=>{ $('#drawModal').classList.add('hidden'); showParentGate(async ()=>{ const dataUrl = canvas.toDataURL('image/png'); const drawings = JSON.parse(localStorage.getItem('drawings')||'[]'); drawings.push({storyId,dataUrl,when:Date.now()}); localStorage.setItem('drawings', JSON.stringify(drawings)); alert('Drawing saved locally.'); }); }; $('#closeDrawing').onclick = ()=> $('#drawModal').classList.add('hidden'); }
function showParentGate(onSuccess){ const modal = $('#parentGate'); modal.classList.remove('hidden'); const a = Math.floor(Math.random()*8)+2; const b = Math.floor(Math.random()*8)+1; $('#gateQuestion').textContent = `What is ${a} + ${b}?`; $('#gateAnswer').value=''; $('#gateSubmit').onclick = ()=> { if(Number($('#gateAnswer').value) === a+b){ modal.classList.add('hidden'); if(onSuccess) onSuccess(); } else alert('Incorrect answer.'); }; $('#gateCancel').onclick = ()=> modal.classList.add('hidden'); }

/* --------- Listening history ---------- */
function addListeningHistory(id){ state.listeningHistory.unshift({id,when:Date.now()}); state.listeningHistory = state.listeningHistory.slice(0,50); localStorage.setItem('listeningHistory', JSON.stringify(state.listeningHistory)); }

/* --------- Navigation & init ---------- */
function showScreen(id){ $$('.screen').forEach(s=>s.classList.add('hidden')); const scr = $(`#${id}`); if(scr) scr.classList.remove('hidden'); toggleMenu(false); }
function toggleMenu(open){ const menu = $('#sideMenu'); if(open){ menu.classList.add('open'); menu.setAttribute('aria-hidden','false'); } else { menu.classList.remove('open'); menu.setAttribute('aria-hidden','true'); } }

document.addEventListener('click', (e)=>{ const navBtn = e.target.closest('.nav-btn'); if(navBtn){ const nav = navBtn.dataset.nav; if(nav){ if(nav==='home') showScreen('home'); else showScreen(nav); if(nav==='storybooks') renderStorybooksGallery(); if(nav==='downloads') renderDownloads(); if(nav==='favorites') renderFavorites(); if(nav==='games') setupMatchingGame(); } }});
$('#menuBtn').onclick = ()=> toggleMenu(true);
$('#closeMenu').onclick = ()=> toggleMenu(false);
$$('.back-btn').forEach(b => b.addEventListener('click', (ev)=> { const nav = ev.target.dataset.nav || 'home'; showScreen(nav); }));

/* Search binding */
$('#searchInput').addEventListener('input', (e)=>{ const q = e.target.value.trim().toLowerCase(); const list = state.episodes.filter(ep => (ep.title + ' ' + ep.description).toLowerCase().includes(q)); renderEpisodes(list); });

/* --------- Initialization ---------- */
async function init(){
  showScreen('splash');
  await IDB.init();
  await updateDownloadSet();
  const episodes = await fetchRSS();
  renderEpisodes();
  renderStorybooksGallery();
  renderRecommendations();
  setupMatchingGame();
  $('#ageGroup').value = localStorage.getItem('ageGroup') || '3-5'; $('#ageGroup').onchange = (e)=> { localStorage.setItem('ageGroup', e.target.value); };
  $('#langSelect').value = localStorage.getItem('lang') || 'en'; $('#langSelect').onchange = (e)=> { localStorage.setItem('lang', e.target.value); };
  $('#offlineToggle').onchange = async (e)=> { if(e.target.checked){ const ids = await IDB.listAudioIds(); const filtered = state.episodes.filter(ep => ids.includes(ep.id)); renderEpisodes(filtered); } else renderEpisodes(); };
  document.querySelector('.player-mini').onclick = ()=> { if(state.playingIndex >= 0) showScreen('player'); };
  if('serviceWorker' in navigator){ try{ await navigator.serviceWorker.register('/sw.js'); console.log('SW registered'); } catch(e){ console.warn('SW failed', e); } }
  showScreen('home');
}
init();

/* --------- Utility functions called earlier ---------- */
async function updateDownloadSet(){ const ids = await IDB.listAudioIds(); state.downloadsSet = new Set(ids); }

/* Expose functions for debugging if needed */
window._app = { state, playEpisodeNow };
