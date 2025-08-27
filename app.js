/* app.js - African Children's Stories (PWA-friendly web app)
   Main responsibilities:
   - Fetch and parse RSS feed
   - Render episode list
   - Audio playback controls
   - Download / offline storage (IndexedDB)
   - Storybooks + TTS
   - Quizzes and simple games
   - Drawing canvas and parent gate
   - Simple favorites and playlists using localStorage
*/

/* --------- CONFIG --------- */
const RSS_FEED = 'https://anchor.fm/s/2d3bd0d0/podcast/rss';
const APP_NAME = "African Children's Stories";
const DB_NAME = 'african_stories_db';
const DB_STORE_AUDIO = 'audio_files';
const PRIMARY_COLOR = '#FF9800';
const CACHE_NAME = 'african-stories-cache-v1';

/* --------- UTILITIES --------- */
function el(q) { return document.querySelector(q); }
function elAll(q) { return document.querySelectorAll(q); }
function formatDate(dStr) {
  try {
    const d = new Date(dStr);
    return d.toLocaleDateString();
  } catch (e) { return dStr; }
}

/* --------- IndexedDB helper for storing audio blobs (very small wrapper) */
const IDB = {
  db: null,
  async init() {
    if (this.db) return;
    return new Promise((res, rej) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = (ev) => {
        const db = ev.target.result;
        if (!db.objectStoreNames.contains(DB_STORE_AUDIO)) {
          db.createObjectStore(DB_STORE_AUDIO, { keyPath: 'id' });
        }
      };
      req.onsuccess = (ev) => {
        this.db = ev.target.result;
        res();
      };
      req.onerror = (ev) => rej(ev);
    });
  },
  async putAudio(id, blob) {
    await this.init();
    return new Promise((res, rej) => {
      const tx = this.db.transaction(DB_STORE_AUDIO, 'readwrite');
      const store = tx.objectStore(DB_STORE_AUDIO);
      store.put({ id, blob });
      tx.oncomplete = () => res(true);
      tx.onerror = (e) => rej(e);
    });
  },
  async getAudio(id) {
    await this.init();
    return new Promise((res, rej) => {
      const tx = this.db.transaction(DB_STORE_AUDIO, 'readonly');
      const store = tx.objectStore(DB_STORE_AUDIO);
      const req = store.get(id);
      req.onsuccess = () => {
        res(req.result ? req.result.blob : null);
      };
      req.onerror = (e) => rej(e);
    });
  },
  async deleteAudio(id) {
    await this.init();
    return new Promise((res, rej) => {
      const tx = this.db.transaction(DB_STORE_AUDIO, 'readwrite');
      const store = tx.objectStore(DB_STORE_AUDIO);
      const req = store.delete(id);
      tx.oncomplete = () => res(true);
      tx.onerror = (e) => rej(e);
    });
  },
  async listAudioIds(){
    await this.init();
    return new Promise((res, rej) => {
      const tx = this.db.transaction(DB_STORE_AUDIO, 'readonly');
      const store = tx.objectStore(DB_STORE_AUDIO);
      const req = store.getAllKeys();
      req.onsuccess = () => res(req.result || []);
      req.onerror = (e) => rej(e);
    });
  }
};

/* --------- State --------- */
const state = {
  episodes: [],       // {id,title,desc,pubDate,audioUrl,imageUrl}
  playing: null,      // current episode id
  favorites: new Set(JSON.parse(localStorage.getItem('favorites') || '[]')),
  listeningHistory: JSON.parse(localStorage.getItem('listeningHistory') || '[]'),
  downloads: new Set(), // ids stored in IDB
  ageGroup: localStorage.getItem('ageGroup') || '3-5',
  lang: localStorage.getItem('lang') || 'en'
};

/* --------- UI Helpers --------- */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.add('hidden'));
  const screen = el(`#${id}`);
  if (screen) screen.classList.remove('hidden');
  // close menu
  toggleMenu(false);
}
function toggleMenu(open){
  const menu = el('#sideMenu');
  if(open){ menu.classList.add('open'); menu.setAttribute('aria-hidden','false'); }
  else { menu.classList.remove('open'); menu.setAttribute('aria-hidden','true'); }
}

/* --------- RSS Fetch & Parse --------- */
async function fetchRSS() {
  // Try fetch; if CORS fails, user will need a CORS proxy or host the app where CORS allowed.
  try {
    const r = await fetch(RSS_FEED);
    if (!r.ok) throw new Error('Network error');
    const text = await r.text();
    const parser = new DOMParser();
    const xml = parser.parseFromString(text, "application/xml");
    const items = Array.from(xml.querySelectorAll('item'));
    const episodes = items.map(item => {
      const title = item.querySelector('title')?.textContent || 'Untitled';
      const description = item.querySelector('description')?.textContent || '';
      const pubDate = item.querySelector('pubDate')?.textContent || '';
      const enclosure = item.querySelector('enclosure');
      const audioUrl = enclosure ? enclosure.getAttribute('url') : (item.querySelector('media\\:content')?.getAttribute('url') || '');
      // itunes image
      const itunesImage = item.querySelector('itunes\\:image')?.getAttribute('href') || xml.querySelector('image > url')?.textContent || null;
      const id = audioUrl || title + pubDate;
      return { id, title, description, pubDate, audioUrl, imageUrl: itunesImage };
    });
    // sort newest first
    episodes.sort((a,b)=> new Date(b.pubDate)-new Date(a.pubDate));
    state.episodes = episodes;
    // cache into localStorage as fallback quick cache
    localStorage.setItem('cachedEpisodes', JSON.stringify(episodes));
    return episodes;
  } catch (err) {
    console.warn('RSS fetch failed, using cache if available', err);
    const cached = localStorage.getItem('cachedEpisodes');
    if (cached) {
      state.episodes = JSON.parse(cached);
      return state.episodes;
    } else {
      return [];
    }
  }
}

/* --------- Render Episodes List --------- */
function renderEpisodes(list = state.episodes) {
  const container = el('#episodeList');
  container.innerHTML = '';
  if (list.length === 0) {
    container.innerHTML = '<div class="muted">No episodes found.</div>';
    return;
  }
  list.forEach(ep => {
    const row = document.createElement('div');
    row.className = 'episode-item card';
    const thumb = document.createElement('img');
    thumb.alt = ep.title;
    thumb.src = ep.imageUrl || 'assets/images/placeholder-baobab.png';
    thumb.width = 84; thumb.height = 84;
    const meta = document.createElement('div');
    meta.className = 'episode-meta';
    const title = document.createElement('h4'); title.textContent = ep.title;
    const date = document.createElement('div'); date.className='muted small'; date.textContent = formatDate(ep.pubDate);
    const desc = document.createElement('p'); desc.textContent = ep.description;
    const actions = document.createElement('div');
    actions.style.marginTop = '8px';

    const playBtn = document.createElement('button');
    playBtn.className = 'big-btn';
    playBtn.textContent = 'Play';
    playBtn.onclick = () => openPlayer(ep);

    const favBtn = document.createElement('button');
    favBtn.className = 'icon-btn';
    favBtn.innerHTML = state.favorites.has(ep.id) ? '❤️' : '♡';
    favBtn.onclick = (ev) => {
      ev.stopPropagation();
      toggleFavorite(ep.id);
      favBtn.innerHTML = state.favorites.has(ep.id) ? '❤️' : '♡';
      renderFavorites();
    };

    const dlBtn = document.createElement('button');
    dlBtn.className = 'icon-btn';
    dlBtn.textContent = state.downloads.has(ep.id) ? '📥' : '⬇';
    dlBtn.onclick = async (ev) => {
      ev.stopPropagation();
      if (state.downloads.has(ep.id)) {
        await IDB.deleteAudio(ep.id);
        state.downloads.delete(ep.id);
        dlBtn.textContent = '⬇';
        renderDownloads();
      } else {
        await downloadEpisode(ep, (p) => {
          dlBtn.textContent = `⬇ ${Math.round(p*100)}%`;
        });
        dlBtn.textContent = '📥';
        renderDownloads();
      }
    };

    actions.appendChild(playBtn);
    actions.appendChild(favBtn);
    actions.appendChild(dlBtn);

    meta.appendChild(title);
    meta.appendChild(date);
    meta.appendChild(desc);
    meta.appendChild(actions);

    row.appendChild(thumb);
    row.appendChild(meta);
    row.onclick = () => openPlayer(ep);
    container.appendChild(row);
  });
}

/* --------- Favorites --------- */
function toggleFavorite(id){
  if(state.favorites.has(id)){
    state.favorites.delete(id);
  } else {
    state.favorites.add(id);
  }
  localStorage.setItem('favorites', JSON.stringify(Array.from(state.favorites)));
}

/* --------- Render favorites screen --------- */
function renderFavorites(){
  const container = el('#favoritesList');
  container.innerHTML = '';
  const favs = state.episodes.filter(e => state.favorites.has(e.id));
  if(favs.length === 0){ container.innerHTML = '<div class="muted">No favorites yet.</div>'; return; }
  favs.forEach(ep => {
    const row = document.createElement('div');
    row.className = 'episode-item card';
    row.innerHTML = `<img src="${ep.imageUrl || 'assets/images/placeholder-baobab.png'}" width=84 height=84 alt="thumb"><div class="episode-meta"><h4>${ep.title}</h4><div class="muted small">${formatDate(ep.pubDate)}</div><p>${ep.description}</p></div>`;
    row.onclick = ()=> openPlayer(ep);
    container.appendChild(row);
  });
}

/* --------- Player logic --------- */
const audio = el('#audio');
let playerTimer = null;

function openPlayer(ep){
  showScreen('player');
  el('#playerThumb').src = ep.imageUrl || 'assets/images/placeholder-baobab.png';
  el('#playerTitle').textContent = ep.title;
  el('#playerDate').textContent = formatDate(ep.pubDate);
  el('#playerDesc').textContent = ep.description;
  state.playing = ep.id;
  // Load either from IDB if downloaded or from network
  loadAudioForPlayback(ep);
  // update mini footer
  el('#miniTitle').textContent = ep.title;
  el('#miniSub').textContent = 'Playing';
  el('#miniPlay').textContent = '⏸';
  // add to listening history for recommendations
  addListeningHistory(ep.id);
}

async function loadAudioForPlayback(ep){
  // attempt to load from IDB
  const blob = await IDB.getAudio(ep.id);
  if(blob){
    const url = URL.createObjectURL(blob);
    audio.src = url;
    audio.load();
    audio.play();
  } else {
    // use remote URL if available
    if(ep.audioUrl){
      audio.src = ep.audioUrl;
      try {
        await audio.play();
      } catch(e){
        console.warn('Autoplay prevented. Wait for user interaction.', e);
      }
    } else {
      alert('No audio available for this episode.');
    }
  }
  setupPlayerBindings(ep);
}

function setupPlayerBindings(ep){
  el('#playPause').onclick = () => {
    if(audio.paused){ audio.play(); el('#playPause').textContent='⏸'; el('#miniPlay').textContent='⏸'; }
    else { audio.pause(); el('#playPause').textContent='▶'; el('#miniPlay').textContent='▶'; }
  };
  el('#back15').onclick = ()=> { audio.currentTime = Math.max(0, audio.currentTime - 15); };
  el('#fwd15').onclick = ()=> { audio.currentTime = Math.min(audio.duration || 0, audio.currentTime + 15); };
  // seek slider
  const seek = el('#seek');
  seek.oninput = (e) => {
    if(audio.duration) audio.currentTime = (seek.value/100) * audio.duration;
  };
  audio.ontimeupdate = ()=>{
    if(audio.duration){
      const pct = (audio.currentTime/audio.duration)*100;
      el('#seek').value = pct;
      el('#curTime').textContent = formatTime(audio.currentTime);
      el('#durTime').textContent = formatTime(audio.duration);
    }
  };
  audio.onended = ()=> {
    el('#playPause').textContent='▶';
    el('#miniPlay').textContent='▶';
  };
  // volume
  el('#volume').oninput = (e)=> { audio.volume = el('#volume').value; };

  // download button
  el('#downloadBtn').onclick = async ()=> {
    if(state.downloads.has(ep.id)){
      await IDB.deleteAudio(ep.id);
      state.downloads.delete(ep.id);
      alert('Download removed.');
      renderDownloads();
    } else {
      await downloadEpisode(ep, (p)=> console.log('download',p));
      alert('Downloaded for offline playback.');
      renderDownloads();
    }
  };

  el('#favBtn').onclick = ()=> {
    toggleFavorite(ep.id);
    el('#favBtn').textContent = state.favorites.has(ep.id) ? '❤️' : '♡';
    renderFavorites();
  };
}

/* --------- helper: format time secs -> mm:ss --------- */
function formatTime(t){
  if(!t || isNaN(t)) return '0:00';
  const mins = Math.floor(t/60);
  const secs = Math.floor(t%60).toString().padStart(2,'0');
  return `${mins}:${secs}`;
}

/* --------- Download episode and store in IDB --------- */
async function downloadEpisode(ep, onProgress){
  if(!ep.audioUrl) return;
  try {
    // fetch as stream
    const resp = await fetch(ep.audioUrl);
    if(!resp.ok) throw new Error('Network error');
    const blob = await resp.blob();
    await IDB.putAudio(ep.id, blob);
    state.downloads.add(ep.id);
    return true;
  } catch (e) {
    console.error('Download failed', e);
    alert('Download failed. This may be due to cross-origin restrictions.');
    return false;
  }
}

/* --------- Render downloads list --------- */
async function renderDownloads(){
  const container = el('#downloadsList');
  container.innerHTML = '';
  const ids = await IDB.listAudioIds();
  if(ids.length===0){ container.innerHTML = '<div class="muted">No downloads.</div>'; return; }
  ids.forEach(id => {
    const ep = state.episodes.find(e=>e.id===id) || {title:id};
    const row = document.createElement('div'); row.className='episode-item card';
    row.innerHTML = `<div class="episode-meta"><h4>${ep.title}</h4><div class="muted small">${ep.pubDate ? formatDate(ep.pubDate) : ''}</div></div>`;
    const playBtn = document.createElement('button'); playBtn.className='big-btn'; playBtn.textContent='Play';
    playBtn.onclick = async ()=>{
      const blob = await IDB.getAudio(id);
      if(blob){
        const url = URL.createObjectURL(blob);
        audio.src = url; audio.play();
        showScreen('player');
        el('#playerTitle').textContent = ep.title || 'Downloaded story';
        el('#playerThumb').src = ep.imageUrl || 'assets/images/placeholder-baobab.png';
      }
    };
    const delBtn = document.createElement('button'); delBtn.className='icon-btn'; delBtn.textContent='Delete';
    delBtn.onclick = async ()=>{
      await IDB.deleteAudio(id); renderDownloads();
    };
    row.appendChild(playBtn); row.appendChild(delBtn);
    container.appendChild(row);
  });
}

/* --------- Listening history for recommendations --------- */
function addListeningHistory(id){
  state.listeningHistory = state.listeningHistory || [];
  state.listeningHistory.unshift({id, when: Date.now()});
  // keep last 50
  state.listeningHistory = state.listeningHistory.slice(0,50);
  localStorage.setItem('listeningHistory', JSON.stringify(state.listeningHistory));
}

/* --------- Search --------- */
el('#searchInput').addEventListener('input', (e)=>{
  const q = e.target.value.trim().toLowerCase();
  const list = state.episodes.filter(ep=>{
    return ep.title.toLowerCase().includes(q) || ep.description.toLowerCase().includes(q);
  });
  renderEpisodes(list);
});

/* --------- Storybooks (static seed) --------- */
const STORYBOOKS = [
  {id:'s1', title:'Anansi and the Moss-Covered Rock', content:`Once upon a time... Anansi the spider finds a moss-covered rock...`},
  {id:'s2', title:'The Tortoise and the Birds', content:`Long ago, the tortoise wanted to fly...`},
  {id:'s3', title:'The Lion\'s Whisker', content:`A tale about courage and love...`}
];

function renderStorybooks(){
  const container = el('#storybookList'); container.innerHTML='';
  STORYBOOKS.forEach(s=>{
    const row = document.createElement('div'); row.className='card episode-item';
    row.innerHTML = `<div class="episode-meta"><h4>${s.title}</h4><p class="muted">${s.content.slice(0,140)}...</p></div>`;
    row.onclick = ()=> openStory(s);
    container.appendChild(row);
  });
}

function openStory(s){
  showScreen('storyDetail');
  el('#storyTitle').textContent = s.title;
  el('#storyContent').textContent = s.content;
  // store current story id on element
  el('#quizBtn').onclick = ()=> openQuizForStory(s);
  el('#ttsBtn').onclick = ()=> speakText(s.content);
  el('#drawBtn').onclick = ()=> openDrawModal(s.id);
}

/* --------- Simple TTS using Web Speech API --------- */
let synth = window.speechSynthesis;
function speakText(text){
  if(!synth) { alert('Text-to-speech not supported'); return; }
  synth.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 0.95;
  utter.lang = state.lang || 'en-US';
  synth.speak(utter);
}

/* --------- Simple Quiz (MCQ) --------- */
function openQuizForStory(story){
  showScreen('quiz');
  const quizInner = el('#quizInner'); quizInner.innerHTML = '';
  // mock questions per story; production would map real questions
  const questions = [
    {q: 'What was the lesson?', opts: ['Be kind','Be greedy','Be loud'], a:'Be kind'},
    {q: 'Who was in the story?', opts: ['Anansi','Robot','Rocket'], a: 'Anansi'}
  ];
  let idx = 0; let score = 0;
  function renderQ(){
    if(idx>=questions.length){ quizInner.innerHTML = `<h3>Score ${score}/${questions.length}</h3><button onclick="showScreen('storyDetail')" class="big-btn">Back</button>`; return; }
    const Q = questions[idx];
    quizInner.innerHTML = `<h3>${Q.q}</h3>`;
    Q.opts.forEach(opt=>{
      const b = document.createElement('button'); b.className='big-btn'; b.style.display='block'; b.style.width='100%';
      b.textContent = opt; b.onclick = ()=>{ if(opt===Q.a) score++; idx++; renderQ(); };
      quizInner.appendChild(b);
    });
  }
  renderQ();
}

/* --------- Simple matching game (drag/drop free alternative) --------- */
const MATCH_PAIRS = [
  {left:'Elephant', right:'Savannah'},
  {left:'Penguin', right:'Antarctic'},
  {left:'Camel', right:'Desert'}
];

function setupMatchingGame(){
  const board = el('#matchBoard'); board.innerHTML='';
  const lefts = MATCH_PAIRS.map(p=>p.left).sort(()=>Math.random()-0.5);
  const rights = MATCH_PAIRS.map(p=>p.right).sort(()=>Math.random()-0.5);
  lefts.forEach(l=>{
    const d = document.createElement('div'); d.className='card'; d.style.padding='8px'; d.style.minWidth='120px';
    d.textContent = l; d.dataset.left=l; d.onclick = ()=> selectMatchingLeft(l,d);
    board.appendChild(d);
  });
  rights.forEach(r=>{
    const d = document.createElement('div'); d.className='card'; d.style.padding='8px'; d.style.minWidth='120px';
    d.textContent = r; d.dataset.right=r; d.onclick = ()=> attemptMatch(r,d);
    board.appendChild(d);
  });
  window.matchSelection = {left:null, leftEl:null, score:0};
  el('#startMatch').onclick = ()=> { window.matchSelection.score=0; el('#matchScore').textContent='Score: 0'; setupMatchingGame(); };
}

function selectMatchingLeft(val, elNode){
  window.matchSelection.left = val; window.matchSelection.leftEl = elNode;
  elNode.style.outline = `3px solid ${PRIMARY_COLOR}`;
}
function attemptMatch(rightVal, elNode){
  if(!window.matchSelection.left) { alert('Select an animal first'); return; }
  // check pair
  const correct = MATCH_PAIRS.find(p=>p.left===window.matchSelection.left && p.right===rightVal);
  if(correct){ window.matchSelection.score++; el('#matchScore').textContent = `Score: ${window.matchSelection.score}`; window.matchSelection.leftEl.style.opacity='0.4'; elNode.style.opacity='0.4'; }
  else { alert('Try again'); }
  window.matchSelection.left = null;
  if(window.matchSelection.leftEl) window.matchSelection.leftEl.style.outline='';
}

/* --------- Drawing canvas --------- */
function openDrawModal(storyId){
  // require parental gate before allow to share
  el('#drawModal').classList.remove('hidden');
  const canvas = el('#drawCanvas');
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = "#fff"; ctx.fillRect(0,0,canvas.width,canvas.height);
  ctx.strokeStyle = '#000'; ctx.lineWidth = 3; ctx.lineCap = 'round';
  let drawing=false;
  canvas.onpointerdown = (e)=> { drawing=true; ctx.beginPath(); ctx.moveTo(e.offsetX, e.offsetY); };
  canvas.onpointermove = (e)=> { if(drawing){ ctx.lineTo(e.offsetX,e.offsetY); ctx.stroke(); } };
  canvas.onpointerup = ()=> drawing=false;
  el('#saveDrawing').onclick = async ()=>{
    // show parent gate before saving/sharing
    closeDrawModal();
    showParentGate(async ()=>{
      // if passed: save drawing to localStorage or offer upload (we keep local)
      const dataUrl = canvas.toDataURL('image/png');
      const drawings = JSON.parse(localStorage.getItem('drawings') || '[]');
      drawings.push({storyId, dataUrl, when:Date.now()});
      localStorage.setItem('drawings', JSON.stringify(drawings));
      alert('Drawing saved locally. Parents can share it from the app.');
    });
  };
  el('#closeDrawing').onclick = closeDrawModal;
}
function closeDrawModal(){ el('#drawModal').classList.add('hidden'); }

/* --------- Parent gate (simple math) --------- */
function showParentGate(onSuccess){
  const modal = el('#parentGate'); modal.classList.remove('hidden');
  const a = Math.floor(Math.random()*8)+2;
  const b = Math.floor(Math.random()*8)+1;
  el('#gateQuestion').textContent = `What is ${a} + ${b}?`;
  el('#gateAnswer').value = '';
  el('#gateSubmit').onclick = ()=>{
    const val = Number(el('#gateAnswer').value);
    if(val === a + b){ modal.classList.add('hidden'); if(onSuccess) onSuccess(); }
    else alert('Incorrect answer. Please try again.');
  };
  el('#gateCancel').onclick = ()=> modal.classList.add('hidden');
}

/* --------- Navigation binding --------- */
document.addEventListener('click', (e)=>{
  const navBtn = e.target.closest('.nav-btn');
  if(navBtn){
    const nav = navBtn.dataset.nav;
    if(nav) {
      if(nav==='home') { showScreen('home'); }
      else showScreen(nav);
      if(nav==='storybooks') renderStorybooks();
      if(nav==='downloads') renderDownloads();
      if(nav==='favorites') renderFavorites();
      if(nav==='games') setupMatchingGame();
    }
  }
});
el('#menuBtn').onclick = ()=> toggleMenu(true);
el('#closeMenu').onclick = ()=> toggleMenu(false);

// back buttons
elAll('.back-btn').forEach(b => b.addEventListener('click', (ev)=> {
  const nav = ev.target.dataset.nav || 'home';
  showScreen(nav);
}));

/* --------- Initialization --------- */
async function init(){
  // show splash then home
  showScreen('splash');
  // init IDB
  await IDB.init();
  const ids = await IDB.listAudioIds();
  ids.forEach(id => state.downloads.add(id));
  // load episodes
  const episodes = await fetchRSS();
  renderEpisodes();
  // attach other UI
  el('#offlineToggle').addEventListener('change', async (e)=>{
    const on = e.target.checked;
    if(on){
      // show only downloads
      const ids = await IDB.listAudioIds();
      const filtered = state.episodes.filter(ep => ids.includes(ep.id));
      renderEpisodes(filtered);
    } else {
      renderEpisodes();
    }
  });
  el('#miniPlay').onclick = ()=> {
    if(audio.paused) { audio.play(); el('#miniPlay').textContent='⏸'; }
    else { audio.pause(); el('#miniPlay').textContent='▶'; }
  }
  // wire mini footer to open player
  document.querySelector('.player-mini').onclick = ()=> {
    if(state.playing) showScreen('player');
  };
  // storybooks
  renderStorybooks();
  // set settings
  el('#ageGroup').value = state.ageGroup;
  el('#ageGroup').onchange = (e)=> { state.ageGroup = e.target.value; localStorage.setItem('ageGroup', state.ageGroup); };
  el('#langSelect').value = state.lang;
  el('#langSelect').onchange = (e)=> { state.lang = e.target.value; localStorage.setItem('lang', state.lang); };

  // feedback button simple
  el('#feedbackBtn').onclick = ()=> { const msg = prompt('Send feedback (optional email):'); if(msg) { alert('Thanks! Feedback saved locally.'); } };

  // initial screen
  showScreen('home');
  // register service worker
  if('serviceWorker' in navigator){
    try {
      await navigator.serviceWorker.register('/sw.js');
      console.log('SW registered');
    } catch(e){ console.warn('SW register failed', e); }
  }
}
init();
