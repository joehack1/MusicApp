// app.js
// Requires: cordova-plugin-media, filechooser, filepath, file, background-mode, music-controls2, android-permissions
let playlist = [];         // array of { path, name, title, artist, album, duration, art }
let currentIndex = 0;
let media = null;
let timer = null;
let isPlaying = false;
let shuffle = false;
let repeatMode = 0; // 0=off,1=all,2=one

const $ = id => document.getElementById(id);

// --- init ---
document.addEventListener('deviceready', init);
function init(){
  // UI bindings
  $.btnPick.addEventListener('click', pickFiles);
  $.play.addEventListener('click', onPlay);
  $.pause.addEventListener('click', onPause);
  $.next.addEventListener('click', nextTrack);
  $.prev.addEventListener('click', prevTrack);
  $.shuffle.addEventListener('click', toggleShuffle);
  $.repeat.addEventListener('click', toggleRepeat);
  $.saveList.addEventListener('click', savePlaylistToStorage);
  $.seekbar.addEventListener('input', onSeekSlide);
  $.seekbar.addEventListener('change', onSeekChange);

  requestStoragePermissions();
  loadSavedPlaylist();
  setupBackgroundMode();
  updateUI();
}

// --- Permissions ---
function requestStoragePermissions(){
  if(!window.cordova || !cordova.plugins || !cordova.plugins.permissions) return;
  const permissions = cordova.plugins.permissions;
  const list = [
    permissions.READ_EXTERNAL_STORAGE,
    permissions.WRITE_EXTERNAL_STORAGE
  ];
  permissions.hasPermission(list, (status) => {
    if(!status.hasPermission) {
      permissions.requestPermissions(list, (s)=> console.log('perm granted', s), (e)=> console.warn('perm denied', e));
    }
  }, (err)=> console.error(err));
}

// --- File picking ---
function pickFiles(){
  // open file chooser multiple times or repeatedly add single file
  window.fileChooser.open(successUri, err => console.error('file choose err', err));
  function successUri(uri){
    // resolve native path
    window.FilePath.resolveNativePath(uri, nativePath => {
      addToPlaylist(nativePath);
    }, (e)=> console.error('resolve path err', e));
  }
}

// --- Playlist management ---
function addToPlaylist(path){
  const name = path.split('/').pop();
  const track = {path, name, title: name, artist:'', album:'', duration:0, art:'assets/placeholder.png'};
  playlist.push(track);
  readTags(track);
  savePlaylistToStorage(); // persist
  updatePlaylistUI();
  if(playlist.length === 1) playIndex(0); // auto play first
}

function removeFromPlaylist(index){
  if(index < 0 || index >= playlist.length) return;
  if(index === currentIndex){
    stopCurrent();
  }
  playlist.splice(index,1);
  if(currentIndex > index) currentIndex--;
  if(currentIndex >= playlist.length) currentIndex = playlist.length-1;
  savePlaylistToStorage();
  updatePlaylistUI();
  updateUI();
}

function moveInPlaylist(from, to){
  const item = playlist.splice(from,1)[0];
  playlist.splice(to,0,item);
  savePlaylistToStorage();
  updatePlaylistUI();
}

// --- read tags (jsmediatags) ---
function readTags(track){
  try{
    window.jsmediatags.read(track.path, {
      onSuccess: function(tag){
        const tags = tag.tags;
        if(tags.title) track.title = tags.title;
        if(tags.artist) track.artist = tags.artist;
        if(tags.album) track.album = tags.album;
        // picture -> convert to blob URL
        if(tags.picture){
          const data = tags.picture.data;
          const format = tags.picture.format;
          let base64String = "";
          for (var i = 0; i < data.length; i++) {
            base64String += String.fromCharCode(data[i]);
          }
          const base64 = btoa(base64String);
          track.art = "data:"+format+";base64,"+base64;
        }
        updatePlaylistUI();
      },
      onError: function(error){
        // tag reading may fail for some file types; ignore
        // console.log('tag error', error);
      }
    });
  }catch(e){
    // jsmediatags may fail on native path formats; ignore
    // console.warn(e);
  }
}

// --- Playback controls ---
function playIndex(index){
  if(index < 0 || index >= playlist.length) return;
  currentIndex = index;
  stopCurrent();
  const p = playlist[currentIndex];
  // create media
  // On Android, Media accepts native file path
  media = new Media(p.path,
    () => { // success = finished playing
      onTrackComplete();
    },
    (err)=> { console.error('media err', err); }
  );
  media.play();
  isPlaying = true;
  startProgressTimer();
  updateUI();
  showMusicControls();
}

function onPlay(){
  if(media) {
    media.play();
    isPlaying = true;
    startProgressTimer();
  } else {
    if(playlist.length) playIndex(currentIndex);
  }
  updateUI();
}

function onPause(){
  if(media) {
    media.pause();
    isPlaying = false;
    stopProgressTimer();
  }
  updateUI();
}

function stopCurrent(){
  if(media){
    try{ media.stop(); }catch(e){}
    try{ media.release(); }catch(e){}
    media = null;
  }
  isPlaying = false;
  stopProgressTimer();
}

function nextTrack(){
  if(playlist.length === 0) return;
  if(shuffle){
    currentIndex = Math.floor(Math.random()*playlist.length);
  } else {
    currentIndex = (currentIndex + 1) % playlist.length;
  }
  playIndex(currentIndex);
}

function prevTrack(){
  if(playlist.length === 0) return;
  if(shuffle){
    currentIndex = Math.floor(Math.random()*playlist.length);
  } else {
    currentIndex = (currentIndex - 1 + playlist.length) % playlist.length;
  }
  playIndex(currentIndex);
}

function onTrackComplete(){
  if(repeatMode === 2){ // repeat one
    playIndex(currentIndex);
  } else if(repeatMode === 1){
    nextTrack();
  } else {
    // repeat off: stop or go next if available
    if(currentIndex < playlist.length-1) nextTrack();
    else { stopCurrent(); updateUI(); }
  }
}

// --- Seek / Progress ---
function startProgressTimer(){
  stopProgressTimer();
  timer = setInterval(()=> {
    if(!media) return;
    media.getCurrentPosition((pos)=>{
      if(pos > -1){
        // pos is seconds (float)
        const secs = Math.floor(pos);
        $.elapsed.textContent = formatTime(secs);
        // update seekbar
        // attempt to get duration
        media.getDuration ? setDurationIfKnown(media.getDuration()) : null;
        const dur = playlist[currentIndex].duration || 0;
        if(dur > 0){
          const percent = Math.min(100, Math.floor((secs / dur) * 100));
          $.seekbar.value = percent;
        }
      }
    }, (e)=>{/*ignore*/});
  }, 800);
}

function stopProgressTimer(){ if(timer) clearInterval(timer); timer = null; }

function setDurationIfKnown(dur){
  // media.getDuration may return -1 until ready; but some implementations return seconds
  if(!dur || dur <= 0) return;
  playlist[currentIndex].duration = Math.floor(dur);
  $.duration.textContent = formatTime(playlist[currentIndex].duration);
}

function onSeekSlide(){ // show scrub preview
  const pct = Number($.seekbar.value);
  const dur = playlist[currentIndex] ? (playlist[currentIndex].duration || 0) : 0;
  const secs = Math.floor((pct/100) * dur);
  $.elapsed.textContent = formatTime(secs);
}

function onSeekChange(){
  const pct = Number($.seekbar.value);
  const dur = playlist[currentIndex] ? (playlist[currentIndex].duration || 0) : 0;
  const secs = Math.floor((pct/100) * dur);
  if(media && typeof media.seekTo === 'function'){
    try{ media.seekTo(secs * 1000); }catch(e){ console.warn('seekTo failed', e); }
  } else {
    // fallback: stop and start at approximate position (may not work)
    // not implemented further
  }
}

// --- Shuffle & Repeat ---
function toggleShuffle(){
  shuffle = !shuffle;
  $.shuffle.style.background = shuffle ? '#e6f3ff' : '';
  updateUI();
}

function toggleRepeat(){
  repeatMode = (repeatMode + 1) % 3;
  const txt = repeatMode === 0 ? 'Repeat: Off' : (repeatMode === 1 ? 'Repeat: All' : 'Repeat: One');
  $.repeat.textContent = txt;
  updateUI();
}

// --- UI updates & playlist rendering ---
function updatePlaylistUI(){
  const ul = $.playlist;
  ul.innerHTML = '';
  playlist.forEach((t, idx) => {
    const li = document.createElement('li');
    const left = document.createElement('div');
    left.style.display='flex'; left.style.alignItems='center'; left.style.gap='10px';
    const title = document.createElement('div');
    title.className='track-name';
    title.textContent = t.title || t.name;
    left.appendChild(title);

    const actions = document.createElement('div');
    const btnPlay = document.createElement('button');
    btnPlay.className='btn-small';
    btnPlay.textContent = (idx === currentIndex && isPlaying) ? 'Playing' : 'Play';
    btnPlay.onclick = ()=> playIndex(idx);

    const btnRemove = document.createElement('button');
    btnRemove.className='btn-small';
    btnRemove.textContent = '✖';
    btnRemove.onclick = ()=> removeFromPlaylist(idx);

    actions.appendChild(btnPlay);
    actions.appendChild(btnRemove);

    li.appendChild(left);
    li.appendChild(actions);
    ul.appendChild(li);
  });
  $.emptyHint.style.display = playlist.length ? 'none' : 'block';
}

function updateUI(){
  // show current track info
  if(playlist[currentIndex]){
    const t = playlist[currentIndex];
    $.trackTitle.textContent = t.title || t.name;
    $.trackArtist.textContent = t.artist || t.album || '';
    $.albumArt.src = t.art || 'assets/placeholder.png';
    if(t.duration) $.duration.textContent = formatTime(t.duration);
  } else {
    $.trackTitle.textContent = 'No track playing';
    $.trackArtist.textContent = '—';
    $.albumArt.src = 'assets/placeholder.png';
    $.duration.textContent = '0:00';
  }

  // controls state
  $.play.style.display = isPlaying ? 'none' : '';
  $.pause.style.display = isPlaying ? '' : 'none';

  // repeat text handled earlier
  updatePlaylistUI();
}

// --- Persistence ---
function savePlaylistToStorage(){
  localStorage.setItem('my_music_playlist', JSON.stringify(playlist));
}

function loadSavedPlaylist(){
  const raw = localStorage.getItem('my_music_playlist');
  if(!raw) return;
  try{
    const arr = JSON.parse(raw);
    if(Array.isArray(arr)) {
      playlist = arr;
      // try to read tags for each (to fetch art/title if missing)
      playlist.forEach(t => readTags(t));
      updatePlaylistUI();
    }
  }catch(e){ console.warn('load playlist err', e); }
}

// --- Helpers ---
function formatTime(s){
  s = Number(s) || 0;
  const m = Math.floor(s/60);
  const sec = Math.floor(s%60).toString().padStart(2,'0');
  return `${m}:${sec}`;
}

// --- Background mode & music notification controls ---
function setupBackgroundMode(){
  try{
    if(window.cordova && cordova.plugins && cordova.plugins.backgroundMode){
      cordova.plugins.backgroundMode.enable();
    }
  }catch(e){ console.warn('bg mode plugin missing'); }

  // Music controls
  try{
    MusicControls.create({
      track       : 'No track playing',
      artist      : '',
      cover       : 'assets/placeholder.png',
      isPlaying   : false,
      dismissable : true,
      hasPrev : true,
      hasNext : true,
      hasClose : true
    }, onControl, onControlsError);

    // subscribe to events
    MusicControls.subscribe((action) => {
      const a = action;
      if(a === 'music-controls-next') nextTrack();
      else if(a === 'music-controls-previous') prevTrack();
      else if(a === 'music-controls-pause') onPause();
      else if(a === 'music-controls-play') onPlay();
      else if(a === 'music-controls-destroy') stopCurrent();
    });

    MusicControls.listen();
  }catch(e){ console.warn('MusicControls init error', e); }
}

function showMusicControls(){
  if(!window.MusicControls) return;
  const t = playlist[currentIndex];
  MusicControls.updateIsPlaying(isPlaying);
  MusicControls.updateMetadata({
    track: t.title || t.name,
    artist: t.artist || '',
    cover: t.art || 'assets/placeholder.png'
  });
}

// handle music control callback stub
function onControl(action){ console.log('music control', action); }
function onControlsError(err){ console.warn('music controls error', err); }

// shorthand DOM elements
Object.assign(window, {
  btnPick: $.btnPick, play: $.play, pause: $.pause, next: $.next, prev: $.prev,
  seekbar: $.seekbar, elapsed: $.elapsed, duration: $.duration,
  trackTitle: $.trackTitle, trackArtist: $.trackArtist, albumArt: $.albumArt,
  playlist: $.playlist, emptyHint: $.emptyHint, shuffleBtn: $.shuffle, repeatBtn: $.repeat,
  saveList: $.saveList
});
