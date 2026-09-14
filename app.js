(function () {
  "use strict";

  var DEFAULT_SETTINGS = {
    schedule: [
      {
        at: "12:40",
        title: "3학년 입장 시작",
        message: "지금부터 3학년은 줄 서도 됩니다.",
        grades: ["3학년"]
      },
      {
        at: "12:50",
        title: "2학년 입장 시작",
        message: "지금부터 3학년과 2학년은 함께 줄 서도 됩니다.",
        grades: ["3학년", "2학년"]
      },
      {
        at: "13:00",
        title: "전 학년 입장 가능",
        message: "지금부터 3학년, 2학년, 1학년 모두 함께 줄 서도 됩니다.",
        grades: ["3학년", "2학년", "1학년"]
      }
    ],
    lunchEndAt: "13:30",
    rule: "현재 표시된 학년은 모두 같은 순서로 줄 서도 됩니다.\n앞 학년에게 양보하지 않아도 됩니다."
  };

  var STORAGE_KEY = "meal-signal-settings-v3";
  var KOREA_TIME_OFFSET_MS = 9 * 60 * 60 * 1000;
  var NETWORK_TIME_SYNC_INTERVAL_MS = 10 * 60 * 1000;
  var isDemoMode = getQueryParam("demo") === "1";
  var demoStartedAt = Date.now();
  var settings = loadSettings();
  var lastStateKey = null;
  var soundEnabled = false;
  var audioContext = null;
  var wakeLock = null;
  var networkClock = {
    synced: false,
    serverEpochMs: 0,
    monotonicMs: 0,
    deviceOffsetMs: 0
  };

  var elements = {};
  var timeFields = ["time3", "time2", "time1", "lunchEndAt"];
  var timeLabels = ["3학년 시작", "2학년 시작", "1학년 시작", "급식 안내 종료"];
  var timePickerState = null;
  var hourButtons = [];
  var minuteButtons = [];
  var settingsPreviousOverflow = "";
  var settingsFeedbackTimer = null;

  function $(selector) {
    return document.querySelector(selector);
  }

  function clone(obj) {
    return JSON.parse(JSON.stringify(obj));
  }

  function getQueryParam(name) {
    var params = window.location.search.substring(1).split("&");
    for (var i = 0; i < params.length; i += 1) {
      var pair = params[i].split("=");
      if (decodeURIComponent(pair[0]) === name) {
        return decodeURIComponent(pair[1] || "");
      }
    }
    return null;
  }

  function loadSettings() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return clone(DEFAULT_SETTINGS);

      var parsed = JSON.parse(raw);
      if (!parsed || !parsed.schedule || parsed.schedule.length !== 3) {
        return clone(DEFAULT_SETTINGS);
      }

      var base = clone(DEFAULT_SETTINGS);
      base.schedule = parsed.schedule;
      base.lunchEndAt = parsed.lunchEndAt || DEFAULT_SETTINGS.lunchEndAt;
      base.rule = parsed.rule || DEFAULT_SETTINGS.rule;
      return base;
    } catch (e) {
      return clone(DEFAULT_SETTINGS);
    }
  }

  function saveSettings(nextSettings) {
    settings = nextSettings;
    var persisted = true;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(nextSettings));
    } catch (e) {
      console.warn("설정 저장 실패:", e);
      persisted = false;
    }
    render();
    return persisted;
  }

  function monotonicNow() {
    if (window.performance && typeof window.performance.now === "function") {
      return window.performance.now();
    }
    return null;
  }

  function currentEpochMs() {
    if (!networkClock.synced) return Date.now();

    var currentMonotonicMs = monotonicNow();
    if (currentMonotonicMs !== null) {
      return networkClock.serverEpochMs + (currentMonotonicMs - networkClock.monotonicMs);
    }
    return Date.now() + networkClock.deviceOffsetMs;
  }

  function currentKoreaTime() {
    return new Date(currentEpochMs() + KOREA_TIME_OFFSET_MS);
  }

  function buildTimeProbeUrl() {
    var base = window.location.href.split("#")[0];
    var separator = base.indexOf("?") === -1 ? "?" : "&";
    return base + separator + "_time_sync=" + Date.now();
  }

  function syncNetworkTime() {
    if (!window.fetch || window.location.protocol === "file:") return;

    var startedAt = Date.now();
    var startedMonotonicMs = monotonicNow();

    try {
      window.fetch(buildTimeProbeUrl(), {
        method: "HEAD",
        cache: "no-store"
      }).then(function (response) {
        var dateHeader = response.headers && response.headers.get("Date");
        var serverEpochMs = Date.parse(dateHeader || "");
        if (!response.ok || !isFinite(serverEpochMs)) {
          throw new Error("서버 시간 응답을 확인할 수 없습니다.");
        }

        var finishedAt = Date.now();
        var finishedMonotonicMs = monotonicNow();
        var roundTripMs = startedMonotonicMs !== null && finishedMonotonicMs !== null
          ? Math.max(0, finishedMonotonicMs - startedMonotonicMs)
          : Math.max(0, finishedAt - startedAt);
        var estimatedNowMs = serverEpochMs + Math.round(roundTripMs / 2);

        networkClock.synced = true;
        networkClock.serverEpochMs = estimatedNowMs;
        networkClock.monotonicMs = finishedMonotonicMs !== null ? finishedMonotonicMs : 0;
        networkClock.deviceOffsetMs = estimatedNowMs - finishedAt;
        document.documentElement.setAttribute("data-clock-source", "network");
        render();
      }).catch(function () {
        document.documentElement.setAttribute("data-clock-source", "device");
      });
    } catch (e) {
      document.documentElement.setAttribute("data-clock-source", "device");
    }
  }

  function minutesOfDay(date) {
    return date.getUTCHours() * 60 + date.getUTCMinutes();
  }

  function toMinutes(hhmm) {
    var parts = String(hhmm || "00:00").split(":");
    return Number(parts[0]) * 60 + Number(parts[1] || 0);
  }

  function sortSchedule(schedule) {
    return schedule.slice().sort(function (a, b) {
      return toMinutes(a.at) - toMinutes(b.at);
    });
  }

  function getCurrentState(now) {
    if (isDemoMode) return getDemoState();

    var current = minutesOfDay(now);
    var sortedSchedule = sortSchedule(settings.schedule);
    var lunchStart = toMinutes(sortedSchedule[0].at);
    var lunchEnd = toMinutes(settings.lunchEndAt || DEFAULT_SETTINGS.lunchEndAt);

    if (current < lunchStart) {
      return {
        key: "before-lunch",
        status: "before",
        modeLabel: "급식 전",
        title: "급식시간 전입니다",
        message: "아직 줄 서는 시간이 아닙니다. 표시가 바뀌면 줄을 서 주세요.",
        grades: [],
        next: sortedSchedule[0]
      };
    }

    if (current >= lunchEnd) {
      return {
        key: "after-lunch",
        status: "ended",
        modeLabel: "급식 종료",
        title: "급식시간이 아닙니다",
        message: "오늘 급식 안내가 종료되었습니다.",
        grades: [],
        next: null
      };
    }

    var active = sortedSchedule[0];
    var next = null;
    for (var i = 0; i < sortedSchedule.length; i += 1) {
      if (current >= toMinutes(sortedSchedule[i].at)) {
        active = sortedSchedule[i];
      } else {
        next = sortedSchedule[i];
        break;
      }
    }

    return {
      key: active.at + "-" + active.title,
      status: "active",
      modeLabel: "입장 가능",
      title: active.title,
      message: active.message,
      grades: active.grades,
      next: next || { at: settings.lunchEndAt || DEFAULT_SETTINGS.lunchEndAt, title: "급식 안내 종료" }
    };
  }

  function getDemoState() {
    var elapsed = Math.floor((Date.now() - demoStartedAt) / 1000) % 50;

    if (elapsed < 10) {
      return {
        key: "demo-before-lunch",
        status: "before",
        modeLabel: "시연 · 급식 전",
        title: "급식시간 전입니다",
        message: "아직 줄 서는 시간이 아닙니다. 표시가 바뀌면 줄을 서 주세요.",
        grades: [],
        next: { at: "시연 10초", title: "3학년 입장 시작" }
      };
    }

    if (elapsed < 20) {
      return {
        key: "demo-grade-3",
        status: "active",
        modeLabel: "시연 중",
        title: "3학년 입장 시작",
        message: "지금부터 3학년은 줄 서도 됩니다.",
        grades: ["3학년"],
        next: { at: "시연 20초", title: "2학년 입장 시작" }
      };
    }

    if (elapsed < 30) {
      return {
        key: "demo-grade-2",
        status: "active",
        modeLabel: "시연 중",
        title: "2학년 입장 시작",
        message: "지금부터 3학년과 2학년은 함께 줄 서도 됩니다.",
        grades: ["3학년", "2학년"],
        next: { at: "시연 30초", title: "전 학년 입장 가능" }
      };
    }

    if (elapsed < 40) {
      return {
        key: "demo-all",
        status: "active",
        modeLabel: "시연 중",
        title: "전 학년 입장 가능",
        message: "지금부터 3학년, 2학년, 1학년 모두 함께 줄 서도 됩니다.",
        grades: ["3학년", "2학년", "1학년"],
        next: { at: "시연 40초", title: "급식 안내 종료" }
      };
    }

    return {
      key: "demo-after-lunch",
      status: "ended",
      modeLabel: "시연 · 급식 종료",
      title: "급식시간이 아닙니다",
      message: "오늘 급식 안내가 종료되었습니다.",
      grades: [],
      next: { at: "시연 반복", title: "급식 전 화면으로 돌아가기" }
    };
  }

  function pad2(value) {
    return value < 10 ? "0" + value : String(value);
  }

  function formatClock(date) {
    return pad2(date.getUTCHours()) + ":" + pad2(date.getUTCMinutes()) + ":" + pad2(date.getUTCSeconds());
  }

  function formatNext(next) {
    if (!next) return "다음 변경: 내일 12:40 · 3학년 입장 시작";
    return "다음 변경: " + next.at + " · " + next.title;
  }

  function setMultilineText(element, text) {
    element.innerHTML = "";
    var lines = String(text || "").split("\n");
    for (var i = 0; i < lines.length; i += 1) {
      if (i > 0) element.appendChild(document.createElement("br"));
      element.appendChild(document.createTextNode(lines[i]));
    }
  }

  function setStatusClass(status) {
    elements.statusPanel.className = "status-panel " + status;
  }

  function render() {
    var now = currentKoreaTime();
    var state = getCurrentState(now);

    elements.clock.textContent = isDemoMode ? formatClock(now) + " · DEMO" : formatClock(now);
    elements.modeLabel.textContent = state.modeLabel;
    elements.title.textContent = state.title;
    elements.message.textContent = state.message;
    elements.grades.textContent = state.grades.length ? state.grades.join(" · ") : (state.status === "ended" ? "종료" : "대기");
    setMultilineText(elements.rule, settings.rule);
    elements.nextInfo.textContent = formatNext(state.next);
    setStatusClass(state.status === "active" ? "active" : state.status === "ended" ? "ended" : "waiting before");

    if (lastStateKey && lastStateKey !== state.key) {
      playChime();
    }
    lastStateKey = state.key;
  }

  function ensureAudioContext(callback) {
    var AudioContextConstructor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextConstructor) {
      if (callback) callback(null);
      return;
    }

    if (!audioContext) audioContext = new AudioContextConstructor();

    if (audioContext.state === "suspended" && audioContext.resume) {
      audioContext.resume().then(function () {
        if (callback) callback(audioContext);
      }).catch(function () {
        if (callback) callback(audioContext);
      });
    } else if (callback) {
      callback(audioContext);
    }
  }

  function playChime() {
    if (!soundEnabled) return;

    ensureAudioContext(function (context) {
      if (!context) return;
      var now = context.currentTime;
      var notes = [784, 988, 1175];

      for (var i = 0; i < notes.length; i += 1) {
        var oscillator = context.createOscillator();
        var gain = context.createGain();
        var start = now + i * 0.16;
        var end = start + 0.28;

        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(notes[i], start);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.28, start + 0.03);
        gain.gain.exponentialRampToValueAtTime(0.0001, end);

        oscillator.connect(gain);
        gain.connect(context.destination);
        oscillator.start(start);
        oscillator.stop(end);
      }
    });
  }

  function requestWakeLock() {
    if (!("wakeLock" in navigator)) return;
    try {
      navigator.wakeLock.request("screen").then(function (lock) {
        wakeLock = lock;
        if (wakeLock && wakeLock.addEventListener) {
          wakeLock.addEventListener("release", function () {
            wakeLock = null;
          });
        }
      }).catch(function (error) {
        console.warn("Wake Lock 실패:", error);
      });
    } catch (e) {
      console.warn("Wake Lock 실패:", e);
    }
  }

  function requestFullscreen() {
    var el = document.documentElement;
    var fn = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
    if (fn) {
      try { fn.call(el); } catch (e) { console.warn("전체화면 실패:", e); }
    }
  }

  function enableSoundAndScreen() {
    soundEnabled = true;
    ensureAudioContext(function () {
      playChime();
    });
    requestWakeLock();
    requestFullscreen();
    elements.soundState.textContent = "알림음 켜짐 · 시간이 바뀌면 소리가 납니다";
    elements.soundState.className = "sound-state on";
    elements.enableSoundButton.textContent = "소리 켜짐";
  }

  function fillSettingsForm(value) {
    var sorted = sortSchedule(value.schedule);
    elements.time3.value = findByGradeCount(sorted, 1).at;
    elements.time2.value = findByGradeCount(sorted, 2).at;
    elements.time1.value = findByGradeCount(sorted, 3).at;
    elements.lunchEndAt.value = value.lunchEndAt || DEFAULT_SETTINGS.lunchEndAt;
    elements.ruleInput.value = value.rule;
    for (var i = 0; i < timeFields.length; i += 1) {
      elements[timeFields[i] + "Button"].textContent = elements[timeFields[i]].value;
    }
  }

  function openSettings() {
    if (!elements.settingsDialog.hidden) return;
    fillSettingsForm(settings);
    timePickerState = null;
    elements.settingsMain.hidden = false;
    elements.timePicker.hidden = true;
    elements.settingsError.hidden = true;
    elements.settingsFeedback.hidden = true;
    elements.settingsDialog.hidden = false;
    settingsPreviousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    elements.displayScreen.setAttribute("aria-hidden", "true");
    elements.time3Button.focus();
  }

  function closeSettings() {
    timePickerState = null;
    elements.settingsDialog.hidden = true;
    elements.timePicker.hidden = true;
    document.body.style.overflow = settingsPreviousOverflow;
    elements.displayScreen.removeAttribute("aria-hidden");
    elements.settingsButton.focus();
  }

  function twoDigits(value) { return value < 10 ? "0" + value : String(value); }

  function updateTimePicker() {
    var selected = timePickerState;
    elements.timePickerValue.textContent = twoDigits(selected.hour) + ":" + twoDigits(selected.minute);
    elements.minuteExact.textContent = twoDigits(selected.minute) + "분";
    for (var i = 0; i < hourButtons.length; i += 1) {
      hourButtons[i].setAttribute("aria-pressed", String(i === selected.hour));
    }
    for (var j = 0; j < minuteButtons.length; j += 1) {
      minuteButtons[j].setAttribute("aria-pressed", String(j * 5 === selected.minute));
    }
  }

  function openTimePicker(index) {
    var raw = elements[timeFields[index]].value;
    var valid = /^([01]\d|2[0-3]):[0-5]\d$/.test(raw);
    var parts = (valid ? raw : "12:00").split(":");
    timePickerState = {index:index, hour:Number(parts[0]), minute:Number(parts[1])};
    elements.timePickerTitle.textContent = timeLabels[index] + " 시간 선택";
    elements.settingsMain.hidden = true;
    elements.timePicker.hidden = false;
    updateTimePicker();
    hourButtons[timePickerState.hour].focus();
  }

  function finishTimePicker(apply) {
    if (!timePickerState) return;
    var field = timeFields[timePickerState.index];
    if (apply) {
      elements[field].value = twoDigits(timePickerState.hour) + ":" + twoDigits(timePickerState.minute);
      elements[field + "Button"].textContent = elements[field].value;
    }
    timePickerState = null;
    elements.timePicker.hidden = true;
    elements.settingsMain.hidden = false;
    elements[field + "Button"].focus();
  }

  function createTimeChoice(value, unit) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "time-choice";
    button.textContent = twoDigits(value);
    button.setAttribute("aria-label", value + (unit === "hour" ? "시" : "분"));
    button.onclick = function () {
      if (!timePickerState) return;
      timePickerState[unit] = value;
      updateTimePicker();
    };
    return button;
  }

  function bindTimePicker() {
    for (var hour = 0; hour < 24; hour += 1) {
      var hourButton = createTimeChoice(hour, "hour");
      hourButtons.push(hourButton); elements.hourChoices.appendChild(hourButton);
    }
    for (var minute = 0; minute < 60; minute += 5) {
      var minuteButton = createTimeChoice(minute, "minute");
      minuteButtons.push(minuteButton); elements.minuteChoices.appendChild(minuteButton);
    }
    for (var i = 0; i < timeFields.length; i += 1) {
      (function (index) { elements[timeFields[index] + "Button"].onclick = function () { openTimePicker(index); }; }(i));
    }
    // Minute adjustment is independent of the chosen hour, like a time wheel.
    elements.minuteMinus.onclick = function () { if (timePickerState) { timePickerState.minute = (timePickerState.minute + 59) % 60; updateTimePicker(); } };
    elements.minutePlus.onclick = function () { if (timePickerState) { timePickerState.minute = (timePickerState.minute + 1) % 60; updateTimePicker(); } };
    elements.applyTimeButton.onclick = function () { finishTimePicker(true); };
    elements.cancelTimeButton.onclick = function () { finishTimePicker(false); };
  }

  function validateSchedule(next) {
    var times = [next.schedule[0].at, next.schedule[1].at, next.schedule[2].at, next.lunchEndAt];
    for (var i = 0; i < times.length; i += 1) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(times[i])) return "00:00~23:59 사이의 시간을 골라 주세요.";
    }
    if (times[0] > times[1] || times[1] > times[2] || times[2] >= times[3]) {
      return "3학년 → 2학년 → 1학년 순서로 정하고, 종료는 마지막 입장보다 늦게 정해 주세요. 같은 시각 입장은 가능합니다.";
    }
    return "";
  }

  function submitSettings(event) {
    event.preventDefault();
    if (timePickerState) { finishTimePicker(true); return; }
    var next = buildSettingsFromForm();
    var error = validateSchedule(next);
    elements.settingsError.textContent = error;
    elements.settingsError.hidden = !error;
    if (error) return;
    var persisted = saveSettings(next);
    closeSettings();
    elements.settingsFeedback.textContent = persisted ? "시간표를 저장했습니다." : "현재 화면에만 적용했습니다. 브라우저가 저장을 허용하지 않아 새로고침하면 원래 시간표로 돌아갑니다.";
    elements.settingsFeedback.hidden = false;
    window.clearTimeout(settingsFeedbackTimer);
    settingsFeedbackTimer = window.setTimeout(function () { elements.settingsFeedback.hidden = true; }, persisted ? 4000 : 12000);
  }

  function settingsKeydown(event) {
    if (event.key === "Escape" || event.keyCode === 27) {
      event.preventDefault();
      if (timePickerState) finishTimePicker(false); else closeSettings();
    }
    if (event.key === "Tab" || event.keyCode === 9) {
      var area = timePickerState ? elements.timePicker : elements.settingsMain;
      var controls = area.querySelectorAll("button:not([disabled]), textarea:not([disabled])");
      if (!controls.length) return;
      var first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }

  function findByGradeCount(schedule, count) {
    for (var i = 0; i < schedule.length; i += 1) {
      if (schedule[i].grades && schedule[i].grades.length === count) return schedule[i];
    }
    return DEFAULT_SETTINGS.schedule[count - 1];
  }

  function buildSettingsFromForm() {
    return {
      schedule: [
        {
          at: elements.time3.value,
          title: "3학년 입장 시작",
          message: "지금부터 3학년은 줄 서도 됩니다.",
          grades: ["3학년"]
        },
        {
          at: elements.time2.value,
          title: "2학년 입장 시작",
          message: "지금부터 3학년과 2학년은 함께 줄 서도 됩니다.",
          grades: ["3학년", "2학년"]
        },
        {
          at: elements.time1.value,
          title: "전 학년 입장 가능",
          message: "지금부터 3학년, 2학년, 1학년 모두 함께 줄 서도 됩니다.",
          grades: ["3학년", "2학년", "1학년"]
        }
      ],
      lunchEndAt: elements.lunchEndAt.value || DEFAULT_SETTINGS.lunchEndAt,
      rule: elements.ruleInput.value.replace(/^\s+|\s+$/g, "") || DEFAULT_SETTINGS.rule
    };
  }

  function clearOldServiceWorkers() {
    try {
      if (!("serviceWorker" in navigator)) return;
      var serviceWorker = navigator.serviceWorker;
      if (!serviceWorker || typeof serviceWorker.getRegistrations !== "function") return;
      serviceWorker.getRegistrations().then(function (registrations) {
        for (var i = 0; i < registrations.length; i += 1) {
          registrations[i].unregister();
        }
      }).catch(function () {});
    } catch (e) {
      console.warn("제한된 iframe에서는 Service Worker 정리를 건너뜁니다.", e);
    }
  }

  function bindEvents() {
    elements.enableSoundButton.onclick = enableSoundAndScreen;
    elements.soundTestButton.onclick = function () {
      soundEnabled = true;
      elements.soundState.textContent = "알림음 켜짐 · 시간이 바뀌면 소리가 납니다";
      elements.soundState.className = "sound-state on";
      playChime();
    };
    elements.fullscreenButton.onclick = requestFullscreen;
    elements.settingsButton.onclick = openSettings;
    elements.settingsForm.onsubmit = submitSettings;
    elements.closeSettingsButton.onclick = closeSettings;
    elements.settingsDialog.addEventListener("keydown", settingsKeydown);
    bindTimePicker();
    elements.resetSettingsButton.onclick = function () {
      fillSettingsForm(DEFAULT_SETTINGS);
      elements.settingsError.hidden = true;
    };

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible" && !wakeLock) requestWakeLock();
    });
  }

  function init() {
    elements = {
      statusPanel: $("#statusPanel"),
      modeLabel: $("#modeLabel"),
      clock: $("#clock"),
      title: $("#title"),
      message: $("#message"),
      grades: $("#grades"),
      rule: $("#rule"),
      nextInfo: $("#nextInfo"),
      enableSoundButton: $("#enableSoundButton"),
      soundTestButton: $("#soundTestButton"),
      fullscreenButton: $("#fullscreenButton"),
      settingsButton: $("#settingsButton"),
      settingsDialog: $("#settingsDialog"),
      displayScreen: $("#displayScreen"),
      settingsForm: $("#settingsForm"),
      settingsMain: $("#settingsMain"),
      settingsError: $("#settingsError"),
      settingsFeedback: $("#settingsFeedback"),
      closeSettingsButton: $("#closeSettingsButton"),
      time3Button: $("#time3Button"),
      time2Button: $("#time2Button"),
      time1Button: $("#time1Button"),
      lunchEndAtButton: $("#lunchEndAtButton"),
      timePicker: $("#timePicker"),
      timePickerTitle: $("#timePickerTitle"),
      timePickerValue: $("#timePickerValue"),
      hourChoices: $("#hourChoices"),
      minuteChoices: $("#minuteChoices"),
      minuteMinus: $("#minuteMinus"),
      minutePlus: $("#minutePlus"),
      minuteExact: $("#minuteExact"),
      applyTimeButton: $("#applyTimeButton"),
      cancelTimeButton: $("#cancelTimeButton"),
      time3: $("#time3"),
      time2: $("#time2"),
      time1: $("#time1"),
      lunchEndAt: $("#lunchEndAt"),
      ruleInput: $("#ruleInput"),
      saveSettingsButton: $("#saveSettingsButton"),
      resetSettingsButton: $("#resetSettingsButton"),
      soundState: $("#soundState")
    };

    bindEvents();
    render();
    clearOldServiceWorkers();
    syncNetworkTime();
    window.setInterval(render, 1000);
    window.setInterval(syncNetworkTime, NETWORK_TIME_SYNC_INTERVAL_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
}());
