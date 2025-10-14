const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cron = require('node-cron');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const path = require('path');
const multer = require('multer');
const uploadService = require('./uploadService');
const config = require('./config');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3001;

// Multer config - за обработка на файлове
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB max
});

// Supabase от config
const supabase = createClient(config.supabase.url, config.supabase.key);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

let radioState = {
  currentTrack: null,
  currentAd: null,
  isPlayingAd: false,
  playlist: [],
  currentTrackIndex: 0,
  startedAt: null,
  isPlaying: true
};

let connectedClients = 0;

class RadioEngine {
  constructor() {
    this.adQueue = [];
    this.isInitialized = false;
  }

  async initialize() {
    try {
      await this.loadPlaylist();
      await this.loadAdSchedule();
      await this.startRadio();
      this.setupAdScheduler();
      this.isInitialized = true;
      console.log('📻 Радиото е стартирано успешно!');
    } catch (error) {
      console.error('❌ Грешка при стартиране на радиото:', error);
    }
  }

  async loadPlaylist() {
    try {
      const { data: songs, error } = await supabase
        .from('songs')
        .select('*')
        .eq('is_active', true)
        .order('created_at');

      if (error) throw error;
      radioState.playlist = songs || [];
      console.log(`🎵 Заредени ${radioState.playlist.length} песни`);
    } catch (error) {
      console.error('Грешка при зареждане на плейлиста:', error);
    }
  }

  async loadAdSchedule() {
    try {
      const { data: schedules, error } = await supabase
        .from('ad_schedule')
        .select(`
          *,
          ads (
            id,
            title,
            file_url,
            duration
          )
        `)
        .eq('is_active', true);

      if (error) throw error;
      this.adSchedules = schedules || [];
      console.log(`📢 Заредени ${this.adSchedules.length} рекламни графика`);
    } catch (error) {
      console.error('Грешка при зареждане на рекламния график:', error);
      this.adSchedules = [];
    }
  }

  startRadio() {
    if (radioState.playlist.length === 0) {
      console.log('⚠️ Няма песни в базата данни');
      return;
    }

    radioState.currentTrackIndex = 0;
    radioState.currentTrack = radioState.playlist[0];
    radioState.startedAt = new Date();
    radioState.isPlaying = true;

    this.scheduleNextTrack();
    this.broadcastState();
  }

  scheduleNextTrack() {
    if (!radioState.isPlaying) return;

    const currentTrack = radioState.currentTrack;
    if (!currentTrack) return;

    const duration = radioState.isPlayingAd 
      ? radioState.currentAd.duration 
      : currentTrack.duration;

    console.log(`🎵 Пускам: ${radioState.isPlayingAd ? radioState.currentAd.title : currentTrack.title} (${duration}s)`);

    setTimeout(() => {
      this.nextTrack();
    }, duration * 1000);
  }

  nextTrack() {
    if (radioState.isPlayingAd) {
      radioState.isPlayingAd = false;
      radioState.currentAd = null;
    } else {
      radioState.currentTrackIndex = (radioState.currentTrackIndex + 1) % radioState.playlist.length;
      radioState.currentTrack = radioState.playlist[radioState.currentTrackIndex];
    }

    radioState.startedAt = new Date();
    this.scheduleNextTrack();
    this.broadcastState();
    this.updateRadioState();
  }

  playAd(ad) {
    console.log(`📢 Пускам реклама: ${ad.title}`);
    
    radioState.isPlayingAd = true;
    radioState.currentAd = ad;
    radioState.startedAt = new Date();

    this.scheduleNextTrack();
    this.broadcastState();
  }

  setupAdScheduler() {
    cron.schedule('* * * * *', async () => {
      await this.checkScheduledAds();
    });
    console.log('⏰ Рекламният планировчик е активиран');
  }

  async checkScheduledAds() {
    const now = new Date();
    const currentTime = now.toTimeString().slice(0, 5);
    const currentDay = now.getDay() === 0 ? 7 : now.getDay();

    for (const schedule of this.adSchedules) {
      if (schedule.scheduled_time === currentTime && 
          schedule.days_of_week.includes(currentDay) &&
          !radioState.isPlayingAd) {
        
        const ad = schedule.ads;
        if (ad) {
          this.playAd(ad);
          break;
        }
      }
    }
  }

  broadcastState() {
    const state = {
      ...radioState,
      timestamp: new Date().toISOString(),
      listeners: connectedClients
    };
    io.emit('radio-state', state);
  }

  async updateRadioState() {
    try {
      await supabase
        .from('radio_state')
        .upsert({
          id: 1,
          current_song_id: radioState.currentTrack?.id,
          current_ad_id: radioState.currentAd?.id,
          is_playing_ad: radioState.isPlayingAd,
          started_at: radioState.startedAt?.toISOString(),
          playlist_id: null
        });
    } catch (error) {
      console.error('Грешка при обновяване на състоянието:', error);
    }
  }
}

// === UPLOAD ENDPOINTS ===

// Провери GitHub Release при старт
(async () => {
  try {
    await uploadService.ensureRelease();
  } catch (error) {
    console.error('⚠️ GitHub грешка:', error.message);
  }
})();

// Upload песен
app.post('/api/upload/song', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Няма прикачен файл' });
    }

    const { title, artist, genre } = req.body;
    if (!title || !artist) {
      return res.status(400).json({ error: 'Липсват задължителни полета (title, artist)' });
    }

    console.log(`📤 Качване на песен: ${title} - ${artist}`);

    // Качи файла в GitHub
    const fileUrl = await uploadService.uploadToGitHub(
      req.file.buffer,
      req.file.originalname,
      'songs'
    );

    // Опитай да вземеш продължителност
    let duration = await uploadService.getAudioDuration(req.file.buffer);
    if (!duration) {
      duration = parseInt(req.body.duration) || 180; // fallback 3min
    }

    // Запази в Supabase
    const { data, error } = await supabase
      .from('songs')
      .insert([{
        title,
        artist,
        genre: genre || 'Неопределен',
        file_url: fileUrl,
        duration,
        is_active: true
      }])
      .select();

    if (error) throw error;

    // Презареди плейлиста
    await radioEngine.loadPlaylist();

    res.json({ 
      success: true, 
      song: data[0],
      message: '✅ Песента е добавена успешно!' 
    });

  } catch (error) {
    console.error('❌ Грешка при качване на песен:', error);
    res.status(500).json({ error: error.message });
  }
});

// Upload реклама
app.post('/api/upload/ad', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Няма прикачен файл' });
    }

    const { title } = req.body;
    if (!title) {
      return res.status(400).json({ error: 'Липсва заглавие' });
    }

    console.log(`📤 Качване на реклама: ${title}`);

    // Качи файла в GitHub
    const fileUrl = await uploadService.uploadToGitHub(
      req.file.buffer,
      req.file.originalname,
      'ads'
    );

    // Опитай да вземеш продължителност
    let duration = await uploadService.getAudioDuration(req.file.buffer);
    if (!duration) {
      duration = parseInt(req.body.duration) || 30; // fallback 30sec
    }

    // Запази в Supabase
    const { data, error } = await supabase
      .from('ads')
      .insert([{
        title,
        file_url: fileUrl,
        duration,
        is_active: true
      }])
      .select();

    if (error) throw error;

    res.json({ 
      success: true, 
      ad: data[0],
      message: '✅ Рекламата е добавена успешно!' 
    });

  } catch (error) {
    console.error('❌ Грешка при качване на реклама:', error);
    res.status(500).json({ error: error.message });
  }
});

// === API ENDPOINTS ===

app.get('/api/radio/state', (req, res) => {
  res.json({
    ...radioState,
    timestamp: new Date().toISOString(),
    listeners: connectedClients
  });
});

// Songs
app.get('/api/songs', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('songs')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/songs', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('songs')
      .insert([req.body])
      .select();
    if (error) throw error;
    await radioEngine.loadPlaylist();
    res.json(data[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/songs/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('songs')
      .delete()
      .eq('id', req.params.id);
    if (error) throw error;
    await radioEngine.loadPlaylist();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Ads
app.get('/api/ads', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('ads')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/ads', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('ads')
      .insert([req.body])
      .select();
    if (error) throw error;
    res.json(data[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/ads/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('ads')
      .delete()
      .eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Schedule
app.get('/api/ad-schedule', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('ad_schedule')
      .select(`
        *,
        ads (
          id,
          title,
          duration
        )
      `)
      .order('scheduled_time');
    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/ad-schedule', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('ad_schedule')
      .insert([req.body])
      .select();
    if (error) throw error;
    await radioEngine.loadAdSchedule();
    res.json(data[0]);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/ad-schedule/:id', async (req, res) => {
  try {
    const { error } = await supabase
      .from('ad_schedule')
      .delete()
      .eq('id', req.params.id);
    if (error) throw error;
    await radioEngine.loadAdSchedule();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/play-ad/:id', async (req, res) => {
  try {
    const { data: ad, error } = await supabase
      .from('ads')
      .select('*')
      .eq('id', req.params.id)
      .single();
    if (error) throw error;
    radioEngine.playAd(ad);
    res.json({ success: true, message: 'Рекламата започна' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// WebSocket
io.on('connection', (socket) => {
  connectedClients++;
  console.log(`🔌 Нов слушател се свърза. Общо: ${connectedClients}`);

  socket.emit('radio-state', {
    ...radioState,
    timestamp: new Date().toISOString(),
    listeners: connectedClients
  });

  socket.on('disconnect', () => {
    connectedClients--;
    console.log(`🔌 Слушател се разкачи. Общо: ${connectedClients}`);
  });

  socket.on('admin-skip-track', () => {
    if (radioEngine.isInitialized) {
      radioEngine.nextTrack();
      console.log('⏭️ Admin прескочи песента');
    }
  });

  socket.on('admin-play-ad', (adId) => {
    supabase
      .from('ads')
      .select('*')
      .eq('id', adId)
      .single()
      .then(({ data: ad, error }) => {
        if (!error && ad) {
          radioEngine.playAd(ad);
          console.log(`📢 Admin пусна реклама: ${ad.title}`);
        }
      });
  });
});

// Static files
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Start server
const radioEngine = new RadioEngine();

server.listen(PORT, async () => {
  console.log(`🚀 Радио сървър стартиран на порт ${PORT}`);
  console.log(`📻 Радио плейър: http://localhost:${PORT}`);
  console.log(`⚙️ Админ панел: http://localhost:${PORT}/admin`);
  await radioEngine.initialize();
});

process.on('SIGINT', () => {
  console.log('\n🛑 Спирам радиото...');
  server.close(() => {
    console.log('✅ Радиото е спряно');
    process.exit(0);
  });
});

module.exports = { app, radioEngine };