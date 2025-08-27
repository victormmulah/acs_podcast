/* app.js - Updated for mobile, CORS fallbacks, advanced player, cleaned descriptions */

/* --------- CONFIG --------- */
const RSS_FEED = 'https://anchor.fm/s/2d3bd0d0/podcast/rss';
const APP_NAME = "African Children's Stories";
const DB_NAME = 'african_stories_db_v2';
const DB_STORE_AUDIO = 'audio_files_v2';
const PRIMARY_COLOR = '#FF9800';

/* Public proxies (fallback order). These are public proxies that may have rate limits;
   for production, host your own proxy. */
const CORS_PROXIES = [
  'https://api.allorigins.win/raw?url=',
  'https://thingproxy.freeboard.io/fetch/',
  'https://api.allorigins.cf/raw?url=',
  // last resort - may require activation: 'https://cors-anywhere.herokuapp.com/'
];

/* --------- Utilities --------- */
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));
function stripHtml(html){
  if(!html) return '';
  // Create a temporary element and use textContent for robust stripping
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return tmp.textContent || tmp.innerText || '';
}
function formatDate(dStr){
  try {
    const d = new Date(dStr);
    return d.toLocaleDateString();
  } catch(e){ return dStr; }
}
function formatTime(t){
  if(!t || isNaN(t)) return '0:00';
  const mins = Math.floor(t/60);
  const secs = Math.floor(t%60).toString().padStart(2,'0');
  return `${mins}:${secs}`;
}

/* --------- IndexedDB for large blobs (audio) ---------- */
const IDB = {
  db: null,
  async init(){
    if(this.db) return;
    return new Promise((res, rej)=>{
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        if(!db.objectStoreNames.contains(DB_STORE_AUDIO)){
          db.createObjectStore(DB_STORE_AUDIO, { keyPath: 'id' });
        }
      };
      req.onsuccess = e => { this.db = e.target.result; res(); };
      req.onerror = e => rej(e);
    });
  },
  async putAudio(id, blob){
    await this.init();
    return new Promise((res, rej)=>{
      const tx = this.db.transaction(DB_STORE_AUDIO, 'readwrite');
      tx.objectStore(DB_STORE_AUDIO).put({ id, blob });
      tx.oncomplete = ()=> res(true);
      tx.onerror = (e)=> rej(e);
    });
  },
  async getAudio(id){
    await this.init();
    return new Promise((res, rej)=>{
      const tx = this.db.transaction(DB_STORE_AUDIO, 'readonly');
      const req = tx.objectStore(DB_STORE_AUDIO).get(id);
      req.onsuccess = ()=> res(req.result ? req.result.blob : null);
      req.onerror = (e)=> rej(e);
    });
  },
  async deleteAudio(id){
    await this.init();
    return new Promise((res, rej)=>{
      const tx = this.db.transaction(DB_STORE_AUDIO, 'readwrite');
      tx.objectStore(DB_STORE_AUDIO).delete(id);
      tx.oncomplete = ()=> res(true);
      tx.onerror = (e)=> rej(e);
    });
  },
  async listAudioIds(){
    await this.init();
    return new Promise((res, rej)=>{
      const tx = this.db.transaction(DB_STORE_AUDIO, 'readonly');
      const req = tx.objectStore(DB_STORE_AUDIO).getAllKeys();
      req.onsuccess = ()=> res(req.result || []);
      req.onerror = (e)=> rej(e);
    });
  }
};

/* --------- App state ---------- */
const state = {
  episodes: [],
  playingIndex: -1,
  favorites: new Set(JSON.parse(localStorage.getItem('favorites') || '[]')),
  listeningHistory: JSON.parse(localStorage.getItem('listeningHistory') || '[]'),
  downloadsMeta: JSON.parse(localStorage.getItem('downloadsMeta') || '{}'), // metadata in localStorage {id:{title,when,size}}
  downloadsSet: new Set(), // filled from IDB
  playlist: [], // array of episode IDs (from state.episodes)
  ageGroup: localStorage.getItem('ageGroup') || '3-5',
  lang: localStorage.getItem('lang') || 'en'
};

/* --------- CORS-resilient fetch helper ---------- */
async function fetchWithCors(url, type = 'text'){
  // Try direct fetch first (best case)
  try {
    const r = await fetch(url, { mode: 'cors' });
    if(!r.ok) throw new Error('Network error ' + r.status);
    if(type === 'text') return await r.text();
    if(type === 'blob') return await r.blob();
    return r;
  } catch (err) {
    console.warn('Direct fetch failed; attempting proxies', err);
    // Try proxies in sequence
    for(const p of CORS_PROXIES){
      try {
        const proxUrl = p + encodeURIComponent(url);
        const r = await fetch(proxUrl);
        if(!r.ok) throw new Error('Proxy failed ' + r.status);
        if(type === 'text') return await r.text();
        if(type === 'blob') return await r.blob();
        return r;
      } catch(e){
        console.warn('Proxy attempt failed with', p, e);
        continue;
      }
    }
    throw new Error('All fetch attempts failed (CORS).');
  }
}

/* --------- RSS parse ---------- */
async function fetchRSS(){
  try {
    const xmlText = await fetchWithCors(RSS_FEED, 'text');
    const parser = new DOMParser();
    const xml = parser.parseFromString(xmlText, 'application/xml');
    const items = Array.from(xml.querySelectorAll('item'));
    const episodes = items.map(item => {
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
    episodes.sort((a,b)=> new Date(b.pubDate) - new Date(a.pubDate));
    state.episodes = episodes;
    // cache for offline
    localStorage.setItem('cachedEpisodes', JSON.stringify(episodes));
    return episodes;
  } catch(e){
    console.warn('RSS failed', e);
    const cached = localStorage.getItem('cachedEpisodes');
    if(cached) {
      state.episodes = JSON.parse(cached);
      return state.episodes;
    }
    return [];
  }
}

/* --------- Render episodes (clean descriptions) ---------- */
function renderEpisodes(list = state.episodes){
  const container = $('#episodeList');
  container.innerHTML = '';
  if(list.length === 0) {
    container.innerHTML = '<div class="muted">No episodes available.</div>';
    return;
  }
  list.forEach((ep, idx) => {
    const row = document.createElement('div');
    row.className = 'episode-item card';
    const img = document.createElement('img');
    img.src = ep.imageUrl || 'assets/images/placeholder-baobab.png';
    img.alt = ep.title;
    img.loading = 'lazy';
    const meta = document.createElement('div'); meta.className = 'episode-meta';
    const title = document.createElement('h4'); title.textContent = ep.title;
    const date = document.createElement('div'); date.className = 'muted small'; date.textContent = formatDate(ep.pubDate);
    const desc = document.createElement('p'); desc.textContent = ep.description || '';
    const actions = document.createElement('div'); actions.style.marginTop = '8px';
    const playBtn = document.createElement('button'); playBtn.className='big-btn'; playBtn.textContent='Play'; playBtn.onclick = (ev)=> { ev.stopPropagation(); openPlayerByIndex(idx); };
    const favBtn = document.createElement('button'); favBtn.className='icon-btn'; favBtn.innerHTML = state.favorites.has(ep.id)?'❤️':'♡'; favBtn.onclick = (ev)=> { ev.stopPropagation(); toggleFavorite(ep.id); favBtn.innerHTML = state.favorites.has(ep.id)?'❤️':'♡'; renderFavorites(); };
    const dlBtn = document.createElement('button'); dlBtn.className='icon-btn'; dlBtn.textContent = state.downloadsMeta[ep.id] ? '📥' : '⬇'; dlBtn.onclick = async (ev)=> { ev.stopPropagation(); await handleDownload(ep, dlBtn); renderDownloads(); };
    actions.append(playBtn, favBtn, dlBtn);

    meta.append(title, date, desc, actions);
    row.append(img, meta);
    row.onclick = ()=> openPlayerByIndex(idx);
    container.appendChild(row);
  });
}

/* --------- Favorites ---------- */
function toggleFavorite(id){
  if(state.favorites.has(id)) state.favorites.delete(id);
  else state.favorites.add(id);
  localStorage.setItem('favorites', JSON.stringify(Array.from(state.favorites)));
}

/* --------- Favorites UI ---------- */
function renderFavorites(){
  const container = $('#favoritesList'); container.innerHTML='';
  const favs = state.episodes.filter(e => state.favorites.has(e.id));
  if(favs.length === 0){ container.innerHTML = '<div class="muted">No favorites yet.</div>'; return; }
  favs.forEach(ep=>{
    const row = document.createElement('div'); row.className='episode-item card';
    row.innerHTML = `<img src="${ep.imageUrl || 'assets/images/placeholder-baobab.png'}" width="96" height="96" alt="thumb"><div class="episode-meta"><h4>${ep.title}</h4><div class="muted small">${formatDate(ep.pubDate)}</div><p>${ep.description}</p></div>`;
    row.onclick = ()=> openPlayerById(ep.id);
    container.appendChild(row);
  });
}

/* --------- Player (advanced) ---------- */
const audio = $('#audio');
let audioCtx = null, analyser = null, sourceNode = null, rafId = null;

async function initAudioVisualizer(){
  if(!window.AudioContext) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    sourceNode = audioCtx.createMediaElementSource(audio);
    sourceNode.connect(analyser);
    analyser.connect(audioCtx.destination);
    analyser.fftSize = 128;
    visualize();
  } catch(e){ console.warn('Visualizer init failed', e); }
}

function visualize(){
  const canvas = $('#visualizer');
  if(!canvas || !analyser) return;
  const ctx = canvas.getContext('2d');
  const bufferLength = analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);

  function draw() {
    rafId = requestAnimationFrame(draw);
    analyser.getByteFrequencyData(dataArray);
    ctx.fillStyle = '#fff';
    ctx.fillRect(0,0,canvas.width, canvas.height);
    const barWidth = (canvas.width / bufferLength) * 1.2;
    let x = 0;
    for(let i=0;i<bufferLength;i++){
      const v = dataArray[i];
      const h = (v/255) * canvas.height;
      ctx.fillStyle = PRIMARY_COLOR;
      ctx.fillRect(x, canvas.height - h, barWidth, h);
      x += barWidth + 1;
    }
  }
  if(!rafId) draw();
}

function stopVisualizer(){
  if(rafId){ cancelAnimationFrame(rafId); rafId = null; }
  if(audioCtx && audioCtx.state !== 'closed'){ try { audioCtx.suspend(); } catch(e){} }
}

function openPlayerByIndex(idx){
  if(idx < 0 || idx >= state.episodes.length) return;
  state.playingIndex = idx;
  const ep = state.episodes[idx];
  openPlayer(ep);
}

function openPlayerById(id){
  const idx = state.episodes.findIndex(e => e.id === id);
  if(idx >= 0) openPlayerByIndex(idx);
}

async function openPlayer(ep){
  showScreen('player');
  $('#playerThumb').src = ep.imageUrl || 'assets/images/placeholder-baobab.png';
  $('#playerTitle').textContent = ep.title;
  $('#playerDate').textContent = formatDate(ep.pubDate);
  $('#playerDesc').textContent = ep.description;
  // set fav/download UI
  $('#favBtn').textContent = state.favorites.has(ep.id) ? '❤️' : '♡';
  $('#downloadBtn').textContent = state.downloadsMeta[ep.id] ? '📥' : '⬇';

  // Load either from IDB (preferred) or remote (with CORS fallback)
  const blob = await IDB.getAudio(ep.id);
  if(blob){
    audio.src = URL.createObjectURL(blob);
    await audio.play().catch(()=>{ /* autoplay may be blocked */ });
  } else {
    // Use remote URL for streaming (no fetch required, browser will handle)
    if(ep.audioUrl){
      audio.src = ep.audioUrl;
      try { await audio.play(); } catch(e){}
    } else {
      alert('No audio URL available for this episode.');
    }
  }

  // Setup player controls and advanced features
  setupPlayerUI();
  setupMediaSession(ep);
  // init visualizer
  await initAudioVisualizer();
}

/* Player UI bindings */
function setupPlayerUI(){
  $('#playPause').onclick = ()=> {
    if(audio.paused){ audio.play(); $('#playPause').textContent='⏸'; $('#miniPlay').textContent='⏸'; }
    else { audio.pause(); $('#playPause').textContent='▶'; $('#miniPlay').textContent='▶'; }
  };
  $('#back15').onclick = ()=> { audio.currentTime = Math.max(0, audio.currentTime - 15); };
  $('#fwd15').onclick = ()=> { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 15); };
  $('#prevBtn').onclick = ()=> { playPrev(); };
  $('#nextBtn').onclick = ()=> { playNext(); };

  $('#speedSelect').onchange = (e)=> audio.playbackRate = Number(e.target.value);
  $('#volume').oninput = (e)=> audio.volume = Number(e.target.value);

  // Seek slider
  const seek = $('#seek');
  seek.oninput = (e) => {
    if(audio.duration) audio.currentTime = (seek.value/100) * audio.duration;
  };
  audio.ontimeupdate = ()=>{
    if(audio.duration){
      const pct = (audio.currentTime / audio.duration) * 100;
      $('#seek').value = pct;
      $('#curTime').textContent = formatTime(audio.currentTime);
      $('#durTime').textContent = formatTime(audio.duration);
    }
  };

  audio.onplay = ()=> { $('#playPause').textContent='⏸'; $('#miniPlay').textContent='⏸'; };
  audio.onpause = ()=> { $('#playPause').textContent='▶'; $('#miniPlay').textContent='▶'; };
  audio.onended = ()=> { $('#playPause').textContent='▶'; $('#miniPlay').textContent='▶'; playNext(); };

  // mini players
  $('#miniPlay').onclick = ()=> {
    if(audio.paused) audio.play(); else audio.pause();
  };

  // fav & download handlers
  $('#favBtn').onclick = ()=> {
    const ep = state.episodes[state.playingIndex];
    if(!ep) return;
    toggleFavorite(ep.id);
    $('#favBtn').textContent = state.favorites.has(ep.id) ? '❤️' : '♡';
    renderFavorites();
  };
  $('#downloadBtn').onclick = async ()=> {
    const ep = state.episodes[state.playingIndex];
    if(!ep) return;
    await handleDownload(ep, $('#downloadBtn'));
    renderDownloads();
  };
}

/* Media Session API (notifications / lock screen) */
function setupMediaSession(ep){
  if('mediaSession' in navigator){
    navigator.mediaSession.metadata = new MediaMetadata({
      title: ep.title,
      artist: 'African Children\'s Stories',
      album: 'Podcast',
      artwork: [
        { src: ep.imageUrl || 'assets/icons/icon-192.png', sizes: '192x192', type: 'image/png' }
      ]
    });
    navigator.mediaSession.setActionHandler('play', ()=> audio.play());
    navigator.mediaSession.setActionHandler('pause', ()=> audio.pause());
    navigator.mediaSession.setActionHandler('seekbackward', ()=> audio.currentTime = Math.max(0, audio.currentTime - 15));
    navigator.mediaSession.setActionHandler('seekforward', ()=> audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 15));
    navigator.mediaSession.setActionHandler('previoustrack', ()=> playPrev());
    navigator.mediaSession.setActionHandler('nexttrack', ()=> playNext());
  }
}

/* Play next/prev in playlist (episodes array) */
function playNext(){
  const next = (state.playingIndex + 1) % state.episodes.length;
  openPlayerByIndex(next);
}
function playPrev(){
  const prev = (state.playingIndex - 1 + state.episodes.length) % state.episodes.length;
  openPlayerByIndex(prev);
}

/* --------- Download logic (localStorage metadata + IDB binary) ---------- */
async function handleDownload(ep, buttonElement){
  // if already downloaded, ask to remove
  if(state.downloadsMeta[ep.id]){
    const remove = confirm('Remove downloaded episode from device?');
    if(remove){
      await IDB.deleteAudio(ep.id);
      delete state.downloadsMeta[ep.id];
      localStorage.setItem('downloadsMeta', JSON.stringify(state.downloadsMeta));
      buttonElement.textContent = '⬇';
      await updateDownloadSet();
      return;
    } else return;
  }

  // Download with CORS fallback
  try {
    buttonElement.textContent = '...';
    const blob = await fetchWithCors(ep.audioUrl, 'blob');
    // Save binary to IDB (safer for large files)
    await IDB.putAudio(ep.id, blob);
    // Save metadata to localStorage (user requested)
    const sizeMB = (blob.size / (1024*1024)).toFixed(2);
    state.downloadsMeta[ep.id] = { title: ep.title, when: Date.now(), sizeMB };
    localStorage.setItem('downloadsMeta', JSON.stringify(state.downloadsMeta));
    buttonElement.textContent = '📥';
    await updateDownloadSet();
    alert('Downloaded for offline playback.');
  } catch(e){
    console.error('Download failed', e);
    // offer helpful note and try proxies hint
    alert('Download failed due to cross-origin restrictions. The app tried public proxies but they can be rate-limited. For reliable downloads, host the app on a domain allowed by the RSS/audio host or set up a simple proxy server.');
    buttonElement.textContent = '⬇';
  }
}

async function updateDownloadSet(){
  const ids = await IDB.listAudioIds();
  state.downloadsSet = new Set(ids);
}

/* --------- Render downloads list ---------- */
async function renderDownloads(){
  const container = $('#downloadsList'); container.innerHTML = '';
  const ids = await IDB.listAudioIds();
  if(ids.length === 0){ container.innerHTML = '<div class="muted">No downloads.</div>'; return; }
  ids.forEach(id=>{
    const meta = state.downloadsMeta[id] || {};
    const ep = state.episodes.find(e => e.id === id) || {title: meta.title || id, pubDate:''};
    const row = document.createElement('div'); row.className='episode-item card';
    row.innerHTML = `<div class="episode-meta"><h4>${ep.title}</h4><div class="muted small">${formatDate(ep.pubDate)}</div><p>${meta.sizeMB ? meta.sizeMB+' MB' : ''}</p></div>`;
    const playBtn = document.createElement('button'); playBtn.className='big-btn'; playBtn.textContent='Play';
    playBtn.onclick = async ()=> {
      const blob = await IDB.getAudio(id);
      if(blob){
        audio.src = URL.createObjectURL(blob);
        await audio.play();
        showScreen('player');
        $('#playerTitle').textContent = ep.title;
      }
    };
    const delBtn = document.createElement('button'); delBtn.className='icon-btn'; delBtn.textContent='Delete';
    delBtn.onclick = async ()=> { if(confirm('Delete download?')){ await IDB.deleteAudio(id); delete state.downloadsMeta[id]; localStorage.setItem('downloadsMeta', JSON.stringify(state.downloadsMeta)); renderDownloads(); } };
    row.append(playBtn, delBtn);
    container.appendChild(row);
  });
}

/* --------- Recommendations (simple based on listening history) ---------- */
function renderRecommendations(){
  const recWrap = $('#recommendations');
  const recList = $('#recList'); recList.innerHTML = '';
  if(!state.listeningHistory || state.listeningHistory.length === 0){ recWrap.classList.add('hidden'); return; }
  // Recommend episodes not in recent history
  const recentIds = new Set(state.listeningHistory.slice(0,10).map(h => h.id));
  const recs = state.episodes.filter(e => !recentIds.has(e.id)).slice(0,4);
  if(recs.length === 0) { recWrap.classList.add('hidden'); return; }
  recWrap.classList.remove('hidden');
  recs.forEach(ep=>{
    const r = document.createElement('div'); r.className='episode-item card';
    r.innerHTML = `<img src="${ep.imageUrl || 'assets/images/placeholder-baobab.png'}" width="96" height="96"><div class="episode-meta"><h4>${ep.title}</h4><div class="muted small">${formatDate(ep.pubDate)}</div><p>${ep.description}</p></div>`;
    r.onclick = ()=> openPlayerById(ep.id);
    recList.appendChild(r);
  });
}

/* --------- Storybooks (static) ---------- */
const STORYBOOKS = [
  {id:'s1', title:'Anansi and the Moss-Covered Rock', content:`Once upon a time, Anansi discovered a mysterious rock that made him sleepy...`},
  {id:'s2', title:'The Tortoise and the Birds', content:`The tortoise wanted to fly so he tricked the birds and...`},
  {id:'s3', title:'The Lion\'s Whisker', content:`A story of courage and love about a brave mother and a lion's whisker...`}
];

function renderStorybooks(){
  const container = $('#storybookList'); container.innerHTML = '';
  STORYBOOKS.forEach(s=>{
    const row = document.createElement('div'); row.className='card episode-item';
    row.innerHTML = `<div class="episode-meta"><h4>${s.title}</h4><p class="muted">${s.content.slice(0,140)}...</p></div>`;
    row.onclick = ()=> openStory(s);
    container.appendChild(row);
  });
}

function openStory(s){
  showScreen('storyDetail');
  $('#storyTitle').textContent = s.title;
  $('#storyContent').textContent = s.content;
  $('#ttsBtn').onclick = ()=> speakText(s.content);
  $('#quizBtn').onclick = ()=> openQuizForStory(s);
  $('#drawBtn').onclick = ()=> openDrawModal(s.id);
}

/* --------- TTS ---------- */
let synth = window.speechSynthesis;
function speakText(text){
  if(!synth){ alert('Text-to-speech not supported on this browser.'); return; }
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = state.lang === 'en' ? 'en-US' : state.lang === 'sw' ? 'sw' : 'fr-FR';
  u.rate = 0.95;
  synth.speak(u);
}

/* --------- Quiz (simple) ---------- */
function openQuizForStory(story){
  showScreen('quiz');
  const quizInner = $('#quizInner'); quizInner.innerHTML = '';
  const questions = [
    {q: 'What was the lesson?', opts: ['Be kind','Be greedy','Be loud'], a:'Be kind'},
    {q: 'Who appears in the story?', opts: ['Anansi','Robot','Dragon'], a:'Anansi'}
  ];
  let idx=0, score=0;
  function renderQ(){
    if(idx>=questions.length){
      quizInner.innerHTML = `<h3>Score ${score}/${questions.length}</h3><button class="big-btn" onclick="showScreen('storyDetail')">Back</button>`;
      return;
    }
    const Q = questions[idx];
    quizInner.innerHTML = `<h3>${Q.q}</h3>`;
    Q.opts.forEach(opt=>{
      const b = document.createElement('button'); b.className='big-btn'; b.style.display='block'; b.style.width='100%';
      b.textContent = opt; b.onclick = ()=> { if(opt===Q.a) score++; idx++; renderQ(); };
      quizInner.appendChild(b);
    });
  }
  renderQ();
}

/* --------- Matching game ---------- */
const MATCH_PAIRS = [
  {left:'Elephant', right:'Savannah'},
  {left:'Camel', right:'Desert'},
  {left:'Crocodile', right:'River'}
];

function setupMatchingGame(){
  const board = $('#matchBoard'); board.innerHTML='';
  const lefts = MATCH_PAIRS.map(p=>p.left).sort(()=>Math.random()-0.5);
  const rights = MATCH_PAIRS.map(p=>p.right).sort(()=>Math.random()-0.5);
  lefts.forEach(l=>{
    const d = document.createElement('div'); d.className='card'; d.style.padding='10px'; d.style.minWidth='120px'; d.textContent = l; d.dataset.left = l; d.onclick = ()=> selectLeft(l,d);
    board.appendChild(d);
  });
  rights.forEach(r=>{
    const d = document.createElement('div'); d.className='card'; d.style.padding='10px'; d.style.minWidth='120px'; d.textContent = r; d.dataset.right = r; d.onclick = ()=> attemptMatch(r,d);
    board.appendChild(d);
  });
  window.matchSelection = {left:null,leftEl:null,score:0};
  $('#startMatch').onclick = ()=> { window.matchSelection.score = 0; $('#matchScore').textContent='Score: 0'; setupMatchingGame(); };
}

function selectLeft(val, elNode){
  window.matchSelection.left = val; window.matchSelection.leftEl = elNode; elNode.style.outline = `3px solid ${PRIMARY_COLOR}`;
}
function attemptMatch(rightVal, elNode){
  if(!window.matchSelection.left){ alert('Select an animal first.'); return; }
  const found = MATCH_PAIRS.find(p=>p.left===window.matchSelection.left && p.right===rightVal);
  if(found){ window.matchSelection.score++; $('#matchScore').textContent = `Score: ${window.matchSelection.score}`; window.matchSelection.leftEl.style.opacity='0.4'; elNode.style.opacity='0.4'; }
  else { alert('Try again.'); }
  if(window.matchSelection.leftEl) window.matchSelection.leftEl.style.outline = '';
  window.matchSelection.left = null;
}

/* --------- Drawing & parental gate ---------- */
function openDrawModal(storyId){
  $('#drawModal').classList.remove('hidden');
  const canvas = $('#drawCanvas');
  const ctx = canvas.getContext('2d'); ctx.fillStyle='#fff'; ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.strokeStyle='#000'; ctx.lineWidth=3; ctx.lineCap='round';
  let drawing=false;
  canvas.onpointerdown = (e)=> { drawing=true; ctx.beginPath(); ctx.moveTo(e.offsetX, e.offsetY); };
  canvas.onpointermove = (e)=> { if(drawing){ ctx.lineTo(e.offsetX, e.offsetY); ctx.stroke(); } };
  canvas.onpointerup = ()=> drawing=false;
  $('#saveDrawing').onclick = ()=> { $('#drawModal').classList.add('hidden'); showParentGate(async ()=> { const dataUrl = canvas.toDataURL('image/png'); const drawings = JSON.parse(localStorage.getItem('drawings')||'[]'); drawings.push({storyId,dataUrl,when:Date.now()}); localStorage.setItem('drawings', JSON.stringify(drawings)); alert('Drawing saved locally.'); }); };
  $('#closeDrawing').onclick = ()=> { $('#drawModal').classList.add('hidden'); };
}

/* Parental gate */
function showParentGate(onSuccess){
  const modal = $('#parentGate'); modal.classList.remove('hidden');
  const a = Math.floor(Math.random()*8)+2; const b = Math.floor(Math.random()*8)+1;
  $('#gateQuestion').textContent = `What is ${a} + ${b}?`;
  $('#gateAnswer').value = '';
  $('#gateSubmit').onclick = ()=> {
    if(Number($('#gateAnswer').value) === a + b){ modal.classList.add('hidden'); if(onSuccess) onSuccess(); }
    else alert('Incorrect answer. Try again.');
  };
  $('#gateCancel').onclick = ()=> modal.classList.add('hidden');
}

/* --------- Navigation & init ---------- */
function showScreen(id){
  $$('.screen').forEach(s => s.classList.add('hidden'));
  const scr = document.getElementById(id);
  if(scr) scr.classList.remove('hidden');
  // close menu
  toggleMenu(false);
}

function toggleMenu(open){
  const menu = $('#sideMenu');
  if(open){ menu.classList.add('open'); menu.setAttribute('aria-hidden','false'); }
  else{ menu.classList.remove('open'); menu.setAttribute('aria-hidden','true'); }
}

document.addEventListener('click', (e)=>{
  const navBtn = e.target.closest('.nav-btn');
  if(navBtn){ const nav = navBtn.dataset.nav; if(nav){ if(nav==='home'){ showScreen('home'); } else { showScreen(nav); } if(nav==='storybooks') renderStorybooks(); if(nav==='downloads') renderDownloads(); if(nav==='favorites') renderFavorites(); if(nav==='games') setupMatchingGame(); } }
});
$('#menuBtn').onclick = ()=> toggleMenu(true);
$('#closeMenu').onclick = ()=> toggleMenu(false);
$$('.back-btn').forEach(b => b.addEventListener('click', (ev)=> { const nav = ev.target.dataset.nav || 'home'; showScreen(nav); }));

/* Search */
$('#searchInput').addEventListener('input', (e)=> {
  const q = e.target.value.trim().toLowerCase();
  const list = state.episodes.filter(ep => (ep.title + ' ' + ep.description).toLowerCase().includes(q));
  renderEpisodes(list);
});

/* Init */
async function init(){
  showScreen('splash');
  await IDB.init();
  await updateDownloadSet();
  const episodes = await fetchRSS();
  // create default playlist of all episode IDs
  state.playlist = episodes.map(e => e.id);
  renderEpisodes();
  renderStorybooks();
  renderRecommendations();
  setupMatchingGame();
  // attach settings
  $('#ageGroup').value = state.ageGroup; $('#ageGroup').onchange = (e)=> { state.ageGroup = e.target.value; localStorage.setItem('ageGroup', state.ageGroup); };
  $('#langSelect').value = state.lang; $('#langSelect').onchange = (e)=> { state.lang = e.target.value; localStorage.setItem('lang', state.lang); };
  // wire offline toggle
  $('#offlineToggle').onchange = async (e) => {
    if(e.target.checked){
      // filter episodes to those downloaded
      const ids = await IDB.listAudioIds();
      const filtered = state.episodes.filter(ep => ids.includes(ep.id));
      renderEpisodes(filtered);
    } else renderEpisodes();
  };
  // mini click
  document.querySelector('.player-mini').onclick = ()=> { if(state.playingIndex >= 0) showScreen('player'); };
  // register service worker (best effort)
  if('serviceWorker' in navigator){
    try{ await navigator.serviceWorker.register('/sw.js'); console.log('SW registered'); } catch(e){ console.warn('SW reg failed', e); }
  }
  // hide splash and show home
  showScreen('home');
}
init();
