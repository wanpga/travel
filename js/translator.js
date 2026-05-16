(function () {
  'use strict';

  var STORAGE_KEY = 'bailian_api_key';
  var PROXY_STORAGE_KEY = 'bailian_proxy_url';
  var WS_BASE = 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime';
  var MODEL = 'qwen3-livetranslate-flash-realtime';

  var apiKey = localStorage.getItem(STORAGE_KEY) || '';
  var proxyUrl = localStorage.getItem(PROXY_STORAGE_KEY) || '';
  var ws = null;
  var audioContext = null;
  var mediaStream = null;
  var processor = null;
  var isRecording = false;
  var eventIdCounter = 0;
  var currentSourceText = '';
  var currentTargetText = '';
  var transcriptEls = { source: null, target: null };

  var $ = function (id) { return document.getElementById(id); };

  function genEventId() {
    return 'evt_' + Date.now() + '_' + (++eventIdCounter);
  }

  function showError(msg) {
    var el = $('error-toast');
    el.textContent = msg;
    el.style.display = 'block';
    setTimeout(function () { el.style.display = 'none'; }, 5000);
  }

  function updateStatus(state, text) {
    var dot = $('record-hint').querySelector('.status-dot');
    dot.className = 'status-dot ' + state;
    $('record-hint').childNodes[1] && ($('record-hint').childNodes[1].textContent = text);
  }

  function clearTranscript() {
    $('transcript-area').innerHTML = '<div class="empty-state">翻译结果将在这里显示</div>';
    currentSourceText = '';
    currentTargetText = '';
    transcriptEls = { source: null, target: null };
  }

  function ensureTranscript() {
    var area = $('transcript-area');
    var empty = area.querySelector('.empty-state');
    if (empty) { empty.remove(); }
  }

  function addSourceItem() {
    ensureTranscript();
    var div = document.createElement('div');
    div.className = 'transcript-item source streaming';
    div.innerHTML = '<div class="label">原文</div><div class="content"></div>';
    $('transcript-area').appendChild(div);
    transcriptEls.source = div;
    currentSourceText = '';
  }

  function addTargetItem() {
    ensureTranscript();
    var div = document.createElement('div');
    div.className = 'transcript-item target streaming';
    div.innerHTML = '<div class="label">译文</div><div class="content"></div>';
    $('transcript-area').appendChild(div);
    transcriptEls.target = div;
    currentTargetText = '';
  }

  function updateSourceText(text) {
    if (transcriptEls.source) {
      currentSourceText = text;
      transcriptEls.source.querySelector('.content').textContent = text;
    }
  }

  function updateTargetText(text) {
    if (transcriptEls.target) {
      currentTargetText = text;
      transcriptEls.target.querySelector('.content').textContent = text;
    }
  }

  function finalizeSource(text) {
    updateSourceText(text);
    if (transcriptEls.source) {
      transcriptEls.source.classList.remove('streaming');
    }
  }

  function finalizeTarget(text) {
    updateTargetText(text);
    if (transcriptEls.target) {
      transcriptEls.target.classList.remove('streaming');
    }
  }

  function connectWS() {
    var url;
    if (proxyUrl) {
      url = proxyUrl + '?api_key=' + encodeURIComponent(apiKey) + '&model=' + encodeURIComponent(MODEL);
    } else {
      url = WS_BASE + '?api_key=' + encodeURIComponent(apiKey) + '&model=' + encodeURIComponent(MODEL);
    }
    ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';

    ws.onopen = function () {
      updateStatus('connected', '已连接，开始说话...');
      sendSessionUpdate();
      startRecording();
    };

    ws.onmessage = function (event) {
      try {
        var msg = JSON.parse(event.data);
        handleMessage(msg);
      } catch (e) {
        console.warn('无法解析消息:', event.data);
      }
    };

    ws.onerror = function (err) {
      console.error('WebSocket 错误:', err);
      showError('WebSocket 连接失败，请检查 API Key 是否正确');
      stopAll();
    };

    ws.onclose = function (e) {
      if (e.code !== 1000) {
        showError('连接关闭 (code: ' + e.code + ')，请重试');
      }
      stopAll();
    };
  }

  function sendSessionUpdate() {
    var sourceLang = $('source-lang').value;
    var targetLang = $('target-lang').value;

    var session = {
      modalities: ['text'],
      input_audio_format: 'pcm16',
      translation: { language: targetLang }
    };

    if (sourceLang !== 'auto') {
      session.input_audio_transcription = {
        language: sourceLang
      };
    } else {
      session.input_audio_transcription = {};
    }

    send({
      event_id: genEventId(),
      type: 'session.update',
      session: session
    });
  }

  function send(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  }

  function sendAudio(base64Data) {
    send({
      event_id: genEventId(),
      type: 'input_audio_buffer.append',
      audio: base64Data
    });
  }

  function finishSession() {
    send({
      event_id: genEventId(),
      type: 'session.finish'
    });
  }

  function handleMessage(msg) {
    switch (msg.type) {
      case 'session.created':
        break;

      case 'session.updated':
        isRecording = true;
        updateStatus('recording', '录音中...');
        break;

      case 'conversation.item.input_audio_transcription.text':
        if (msg.stash !== undefined) {
          if (!transcriptEls.source) addSourceItem();
          updateSourceText((msg.text || '') + (msg.stash || ''));
        }
        break;

      case 'conversation.item.input_audio_transcription.completed':
        if (msg.transcript) {
          if (!transcriptEls.source) addSourceItem();
          finalizeSource(msg.transcript);
        }
        break;

      case 'response.audio_transcript.text':
        if (!transcriptEls.target) addTargetItem();
        updateTargetText((msg.text || '') + (msg.stash || ''));
        break;

      case 'response.audio_transcript.done':
        if (msg.transcript) {
          if (!transcriptEls.target) addTargetItem();
          finalizeTarget(msg.transcript);
        }
        break;

      case 'response.text.text':
        if (!transcriptEls.target) addTargetItem();
        updateTargetText((msg.text || '') + (msg.stash || ''));
        break;

      case 'response.done':
        break;

      case 'error':
        showError('服务端错误: ' + (msg.error ? msg.error.message : '未知错误'));
        stopAll();
        break;

      case 'session.finished':
        stopAll();
        break;
    }
  }

  function arrayBufferToBase64(buffer) {
    var bytes = new Uint8Array(buffer);
    var binary = '';
    for (var i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  function float32ToInt16(float32Array) {
    var int16 = new Int16Array(float32Array.length);
    for (var i = 0; i < float32Array.length; i++) {
      var s = Math.max(-1, Math.min(1, float32Array[i]));
      int16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return int16.buffer;
  }

  function startRecording() {
    if (!audioContext) {
      audioContext = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    }

    navigator.mediaDevices.getUserMedia({ audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      .then(function (stream) {
        mediaStream = stream;
        var source = audioContext.createMediaStreamSource(stream);
        processor = audioContext.createScriptProcessor(4096, 1, 1);

        source.connect(processor);
        processor.connect(audioContext.destination);

        processor.onaudioprocess = function (e) {
          if (!isRecording || !ws || ws.readyState !== WebSocket.OPEN) return;
          var inputData = e.inputBuffer.getChannelData(0);
          var pcm16 = float32ToInt16(inputData);
          var base64 = arrayBufferToBase64(pcm16);
          sendAudio(base64);
        };
      })
      .catch(function (err) {
        showError('无法访问麦克风: ' + err.message);
        stopAll();
      });
  }

  function stopRecording() {
    isRecording = false;
    if (processor) {
      processor.disconnect();
      processor = null;
    }
    if (mediaStream) {
      mediaStream.getTracks().forEach(function (t) { t.stop(); });
      mediaStream = null;
    }
    if (audioContext && audioContext.state !== 'closed') {
      audioContext.close().catch(function () {});
      audioContext = null;
    }
  }

  function stopAll() {
    isRecording = false;

    if (ws && ws.readyState === WebSocket.OPEN) {
      try { finishSession(); } catch (e) {}
      ws.close(1000);
    }
    ws = null;

    stopRecording();

    $('record-btn').classList.remove('recording', 'connecting');
    updateStatus('idle', '点击按钮开始录音');
  }

  $('record-btn').addEventListener('click', function () {
    if (isRecording || (ws && ws.readyState === WebSocket.OPEN)) {
      stopAll();
      return;
    }

    var key = apiKey || $('api-key-input').value.trim();
    if (!key) {
      showError('请先输入并保存 API Key');
      return;
    }
    $('api-key-input').value = key;

    eventIdCounter = 0;
    clearTranscript();
    $('record-btn').classList.add('connecting');
    updateStatus('connecting', '连接中...');
    connectWS();
  });

  $('api-key-save').addEventListener('click', function () {
    var val = $('api-key-input').value.trim();
    if (!val) {
      showError('请输入 API Key');
      return;
    }
    apiKey = val;
    localStorage.setItem(STORAGE_KEY, val);
    $('api-key-input').value = '';
    $('api-key-input').placeholder = '已保存 (' + val.substring(0, 8) + '...)';
    $('api-key-save').textContent = '已保存';
    setTimeout(function () { $('api-key-save').textContent = '保存'; }, 1500);
  });

  if (apiKey) {
    $('api-key-input').placeholder = '已保存 (' + apiKey.substring(0, 8) + '...)';
  }

  if (proxyUrl) {
    $('proxy-input').placeholder = '已保存 (' + proxyUrl + ')';
  }

  $('proxy-save').addEventListener('click', function () {
    var val = $('proxy-input').value.trim();
    if (!val) {
      proxyUrl = '';
      localStorage.removeItem(PROXY_STORAGE_KEY);
      $('proxy-input').placeholder = '输入函数计算 WebSocket 代理地址';
      $('proxy-input').value = '';
      $('proxy-save').textContent = '已清除';
      setTimeout(function () { $('proxy-save').textContent = '保存'; }, 1500);
      return;
    }
    if (!/^wss?:\/\//.test(val)) {
      showError('代理地址必须以 ws:// 或 wss:// 开头');
      return;
    }
    proxyUrl = val.replace(/\/+$/, '');
    localStorage.setItem(PROXY_STORAGE_KEY, proxyUrl);
    $('proxy-input').value = '';
    $('proxy-input').placeholder = '已保存 (' + proxyUrl + ')';
    $('proxy-save').textContent = '已保存';
    setTimeout(function () { $('proxy-save').textContent = '保存'; }, 1500);
  });

})();
