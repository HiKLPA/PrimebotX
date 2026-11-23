/* 对话卡（右栏 Shortcuts 页的 Dialog 组）拖到机器人身上之后的那一句。
   动作卡走的是「机器人播动作」，对话卡没有动作可播 —— 接卡仪式走完
   （robot3d 在 release 节点派发 robot-card），这里替用户开口问一句，
   后面就是 assistant_chat 的常规对话：用户气泡、思考中、回复落进
   聊天记录与舞台流，和手打一句完全同一条路。

   点一下卡片是拖的退路：不经过仪式，直接发。

   天气那张不把「本地」丢给模型去猜 —— 模型没有实时天气，猜出来的
   数字比不答更糟。这里先用浏览器定位取经纬度，再向 Open-Meteo
   （免 key）要今天起三天的预报，把温度和降水概率写进提问里，
   模型只负责据此给出行建议。
   定位被拒或超时不是终点：再按出口 IP 估一次城市（同样免 key，
   没有权限弹窗），拿到坐标照样取真实预报。两条路都断了才退回
   「不带数字」的那一问，链路不断。

   取数在指针按下时就起跑：接卡仪式本身有 3.4 秒，等松手再取
   等于让用户多等一个来回。结果缓存十分钟，连着问两次不会重复请求。 */
(function () {
  var FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
  var IP_URL = 'https://ipwho.is/';  /* 按出口 IP 估城市，免 key、无权限弹窗 */
  var CACHE_MS = 10 * 60 * 1000;  /* 十分钟内的第二次触发直接用手里的那份 */
  var LOCATE_MS = 4000;           /* 定位最多等这么久，超时按「没有坐标」处理 */
  var IP_MS = 3500;               /* IP 定位的超时 */
  var FETCH_MS = 5000;            /* 预报接口的超时 */
  var WAIT_MS = 3000;             /* 触发之后最多再等这么久；超时就先问，不等天气 */

  /* WMO 天气代码 → 一句话。键是 Open-Meteo 的 weather_code，
     查不到的组合（比如只在国内出现的沙尘）落到「天气」这个兜底词上 */
  var WMO = {
    0: ['晴', 'Clear'],
    1: ['大致晴', 'Mostly clear'],
    2: ['多云', 'Partly cloudy'],
    3: ['阴', 'Overcast'],
    45: ['有雾', 'Fog'],
    48: ['雾凇', 'Freezing fog'],
    51: ['细雨', 'Light drizzle'],
    53: ['小雨', 'Drizzle'],
    55: ['密雨', 'Dense drizzle'],
    56: ['冻雨', 'Freezing drizzle'],
    57: ['冻雨', 'Freezing drizzle'],
    61: ['小雨', 'Light rain'],
    63: ['中雨', 'Rain'],
    65: ['大雨', 'Heavy rain'],
    66: ['冻雨', 'Freezing rain'],
    67: ['冻雨', 'Freezing rain'],
    71: ['小雪', 'Light snow'],
    73: ['中雪', 'Snow'],
    75: ['大雪', 'Heavy snow'],
    77: ['米雪', 'Snow grains'],
    80: ['阵雨', 'Rain showers'],
    81: ['阵雨', 'Rain showers'],
    82: ['强阵雨', 'Violent showers'],
    85: ['阵雪', 'Snow showers'],
    86: ['强阵雪', 'Heavy snow showers'],
    95: ['雷阵雨', 'Thunderstorm'],
    96: ['雷阵雨伴冰雹', 'Thunderstorm with hail'],
    99: ['雷阵雨伴冰雹', 'Thunderstorm with hail'],
  };

  var cache = null;     /* {t, place, days}：最近一次取到的预报 */
  var inflight = null;  /* 正在跑的那次取数，重复触发共用一份 */

  function zh() {
    return (document.documentElement.lang || '').toLowerCase().indexOf('zh') === 0;
  }

  function tr(key, fallback) {
    var value = typeof window.t === 'function' ? window.t(key) : '';
    return value && value !== key ? value : fallback;
  }

  function delay(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function locate() {
    return new Promise(function (resolve) {
      if (!navigator.geolocation) { resolve(null); return; }
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        resolve(null);
      }, LOCATE_MS);
      navigator.geolocation.getCurrentPosition(function (position) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          lat: position.coords.latitude,
          lon: position.coords.longitude,
        });
      }, function () {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(null);
      }, { timeout: LOCATE_MS, maximumAge: 5 * 60 * 1000 });
    });
  }

  /* 定位被拒或超时的兜底：按出口 IP 估一个城市。精度只到城市，
     但足够取这一城的预报，而且不弹权限框、不打断接卡仪式。
     接口把失败写在 success:false 里，HTTP 仍是 200，得看字段 */
  function ipLocate() {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, IP_MS);
    /* 城市名跟着界面语言走：中文界面拿到「珠海」，英文界面拿到「Zhuhai」，
       这条名字会原样嵌进那句提问里 */
    var url = IP_URL + (zh() ? '?lang=zh-CN' : '');
    return fetch(url, { signal: controller.signal })
      .then(function (response) {
        if (!response.ok) throw new Error('ip locate failed');
        return response.json();
      })
      .then(function (json) {
        if (!json || json.success === false) return null;
        if (typeof json.latitude !== 'number' || typeof json.longitude !== 'number') return null;
        return {
          lat: json.latitude,
          lon: json.longitude,
          city: typeof json.city === 'string' ? json.city : '',
        };
      })
      .catch(function () { return null; })
      .then(function (value) { clearTimeout(timer); return value; });
  }

  /* 三维度取坐标：精确到街区的那一条优先，拒绝授权就走 IP 那一条 */
  function coords() {
    return locate().then(function (value) { return value || ipLocate(); });
  }

  /* 三天足够回答「近几日」：再长一行行数字堆进提问里，
     模型的回答反而会被数字牵着走，出行建议变得零零碎碎 */
  /* 接口在缺测的日子会给 null，直接 Math.round(null) 会写出一个 0℃，
     比不写更误导 —— 不是数字就整段省掉 */
  function round(value) {
    return typeof value === 'number' && isFinite(value) ? Math.round(value) : null;
  }

  function build(data, where) {
    var daily = data && data.daily;
    if (!daily || !daily.time || !daily.time.length) return null;
    var count = Math.min(3, daily.time.length);
    var lines = [];
    var chinese = zh();
    for (var i = 0; i < count; i += 1) {
      var code = daily.weather_code ? daily.weather_code[i] : null;
      var label = WMO[code] ? WMO[code][chinese ? 0 : 1] : (chinese ? '天气' : 'Weather');
      var high = round(daily.temperature_2m_max ? daily.temperature_2m_max[i] : null);
      var low = round(daily.temperature_2m_min ? daily.temperature_2m_min[i] : null);
      var rain = round(daily.precipitation_probability_max ? daily.precipitation_probability_max[i] : null);
      var time = String(daily.time[i] || '').slice(5);  /* 只留 MM-DD，年份在这句里没有信息量 */
      var line = time + ' ' + label;
      if (high !== null && low !== null) line += ' ' + low + '~' + high + '℃';
      if (rain !== null && rain !== undefined) line += (chinese ? ' 降水 ' : ' rain ') + rain + '%';
      lines.push(line);
    }
    return {
      t: Date.now(),
      /* 有城市名就用城市名，只有 GPS 坐标时退回经纬度两位小数，
         提问里读起来是「我这边（上海）」而不是一串小数 */
      place: where.city || (where.lat.toFixed(2) + ', ' + where.lon.toFixed(2)),
      days: lines.join(chinese ? '；' : '; '),
    };
  }

  function fetchForecast(where) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, FETCH_MS);
    var url = FORECAST_URL
      + '?latitude=' + where.lat.toFixed(3)
      + '&longitude=' + where.lon.toFixed(3)
      + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max'
      + '&timezone=auto&forecast_days=3';
    return fetch(url, { signal: controller.signal })
      .then(function (response) {
        if (!response.ok) throw new Error('forecast failed');
        return response.json();
      })
      .then(function (json) { return build(json, where); })
      .catch(function () { return null; })
      .then(function (value) { clearTimeout(timer); return value; });
  }

  function prefetch() {
    if (cache && Date.now() - cache.t < CACHE_MS) return Promise.resolve(cache);
    if (inflight) return inflight;
    inflight = coords().then(function (where) {
      if (!where) return null;
      return fetchForecast(where);
    }).then(function (value) {
      inflight = null;
      if (value) cache = value;
      return value;
    });
    return inflight;
  }

  function promptText(data) {
    if (data && data.days) {
      return tr(
        'rail.left.card.weather.prompt.data',
        '我这边（{place}）未来三天的天气是：{days}。先说一句这三天的天气概况，再用两三句话告诉我该怎么穿、要不要带伞、适不适合安排户外活动。'
      ).replace('{place}', data.place).replace('{days}', data.days);
    }
    return tr(
      'rail.left.card.weather.prompt',
      '帮我看看本地最近几天的天气，再给点出行建议：穿什么、要不要带伞、适不适合安排户外活动。'
    );
  }

  function sendWeather() {
    var chat = window.primebotxChat;
    if (!chat || typeof chat.send !== 'function') return;
    var ready = cache && Date.now() - cache.t < CACHE_MS ? Promise.resolve(cache) : prefetch();
    /* 取数比人慢的时候不干等：先发一句不带数字的，模型照样能接上话，
       用户问一句「哪里的天气」就补上了。等太久还会把已经打了一半的字清掉 */
    Promise.race([ready, delay(WAIT_MS).then(function () { return null; })]).then(function (data) {
      chat.send(promptText(data));
    });
  }

  var DIALOGS = {
    weather: sendWeather,
  };

  function trigger(id) {
    var run = DIALOGS[id];
    if (typeof run === 'function') run();
  }

  function activate(card) {
    if (!card) return;
    trigger(card.getAttribute('data-dialog'));
    /* 与动作卡同一记反馈：整卡染上系列色，一秒后自己退掉。
       对话本身没有时长可跟，这里只是让「点到了」有个回声 */
    card.classList.add('is-on');
    clearTimeout(card.__dialogTimer);
    card.__dialogTimer = setTimeout(function () { card.classList.remove('is-on'); }, 900);
  }

  Array.prototype.forEach.call(document.querySelectorAll('.sc[data-dialog]'), function (card) {
    card.addEventListener('click', function () { activate(card); });
    card.addEventListener('keydown', function (event) {
      if (event.target !== card) return;
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      activate(card);
    });
  });

  /* 按下就开始取天气：等接卡仪式走完（3.4s）再取，等于把定位和接口
     的两个来回全压在用户眼皮底下 */
  document.addEventListener('pointerdown', function (event) {
    if (event.button !== 0) return;
    if (!event.target.closest) return;
    if (event.target.closest('.sc[data-dialog="weather"]')) prefetch();
  }, true);

  /* 拖到机器人身上、仪式走完：card_pickup 在 release 那一拍把卡上的
     data-dialog 传出来，这里接手。没走这条路的是点击触发 */
  window.addEventListener('primebotx-dialog-card', function (event) {
    trigger(event.detail && event.detail.id);
  });
})();
