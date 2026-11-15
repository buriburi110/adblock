// 치지직 공개 재생 정보 및 확인된 영상광고 응답만 처리합니다.
// 로그인·권한·종료 상태, 비대상 응답과 광고 외의 메타데이터는 보존합니다.
(() => {
  if (
    location.hostname !== "chzzk.naver.com" ||
    location.protocol !== "https:"
  ) {
    return;
  }

  const INSTALL_KEY = Symbol.for("lae.chzzk.response.v2");
  if (window[INSTALL_KEY]) {
    return;
  }
  try {
    Object.defineProperty(window, INSTALL_KEY, { value: true });
  } catch {
    return;
  }

  const parse = JSON.parse;
  const stringify = JSON.stringify;
  const hasOwn = Function.call.bind(Object.prototype.hasOwnProperty);
  const diagnostics = {
    schema: 2,
    revision: "1.9.3",
    installed: { xhr: false, fetch: false, parser: false, tunnel: false },
    counts: { apiPatches: 0, publicPlaybacks: 0, adPolicies: 0, waterfalls: 0 },
    playbackChecks: {
      candidates: 0, descriptorRejected: 0, entitlementRejected: 0,
      mediaShapeRejected: 0, mediaUrlRejected: 0, mediaHostRejected: 0,
      noP2pPaths: 0, partiallyPatched: 0, fullyPatched: 0,
    },
  };
  const activeChecks = {};
  let diagnosticsObserver = null;

  function publishDiagnostics() {
    try {
      const root = document.documentElement;
      if (typeof root?.setAttribute !== "function") {
        return false;
      }
      const active = {};
      for (const name of Object.keys(diagnostics.installed)) {
        try {
          active[name] = diagnostics.installed[name] && activeChecks[name]?.() === true;
        } catch {
          active[name] = false;
        }
      }
      // 진단에는 버전·훅 상태·횟수만 기록합니다. 응답·주소·키·사용자 정보는 넣지 않습니다.
      root.setAttribute("data-lae-chzzk-diagnostics", stringify({ ...diagnostics, active }));
      diagnosticsObserver?.disconnect();
      diagnosticsObserver = null;
      return true;
    } catch {
      return false;
    }
  }

  function countPatch(name) {
    diagnostics.counts[name] = Math.min(1_000_000, diagnostics.counts[name] + 1);
    publishDiagnostics();
  }

  function installDiagnostics() {
    if (typeof document.addEventListener === "function") {
      document.addEventListener("DOMContentLoaded", publishDiagnostics, { once: true });
      document.addEventListener("lae-player-state", publishDiagnostics);
      document.addEventListener("visibilitychange", publishDiagnostics);
    }
    if (publishDiagnostics()) {
      return;
    }
    if (!document.documentElement && typeof MutationObserver === "function") {
      try {
        diagnosticsObserver = new MutationObserver(publishDiagnostics);
        diagnosticsObserver.observe(document, { childList: true });
      } catch {
        diagnosticsObserver = null;
      }
    }
  }

  const LIVE_DETAIL_PATH = /^\/service\/v[1-9]\d*(?:\.\d+)*\/channels\/[^/]+\/live-detail(?:-meta)?\/?$/;
  const LIVE_STATUS_PATH = /^\/polling\/v[1-9]\d*(?:\.\d+)*\/channels\/[^/]+\/live-status\/?$/;
  const AD_POLICY_PATH = /^\/service\/v[1-9]\d*(?:\.\d+)*\/seoraksan\/?$/;

  function filteringEnabled() {
    // 기존 탭의 OFF도 반영합니다. 초기 속성 부재는 등록 시 ON 결정을 따릅니다.
    return document.documentElement?.getAttribute("data-lae-player") !== "off";
  }

  function isObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function targetKind(value) {
    try {
      const url = new URL(value, location.href);
      if (
        url.protocol !== "https:" ||
        url.hostname !== "api.chzzk.naver.com" ||
        url.port !== ""
      ) {
        return null;
      }
      if (LIVE_DETAIL_PATH.test(url.pathname)) {
        return "liveDetail";
      }
      if (LIVE_STATUS_PATH.test(url.pathname)) {
        return "liveStatus";
      }
      return AD_POLICY_PATH.test(url.pathname) ? "adPolicy" : null;
    } catch {
      return null;
    }
  }

  function requestUrl(input) {
    if (typeof input === "string") {
      return input;
    }
    if (input instanceof URL) {
      return input.href;
    }
    return typeof input?.url === "string" ? input.url : "";
  }

  function unthrottle(pollingStatusJson) {
    try {
      const status = parse(pollingStatusJson);
      if (
        !isObject(status) ||
        status.status !== "STARTED" ||
        status.playableStatus !== "FORCE_LOW_RESOLUTION" ||
        typeof status.trafficThrottling !== "number" ||
        !Number.isFinite(status.trafficThrottling)
      ) {
        return pollingStatusJson;
      }
      status.playableStatus = "PLAYABLE";
      status.trafficThrottling = -1;
      return stringify(status);
    } catch {
      return pollingStatusJson;
    }
  }

  function patchLiveStatus(content) {
    let changed = false;
    if (typeof content.livePollingStatusJson === "string") {
      const patched = unthrottle(content.livePollingStatusJson);
      if (patched !== content.livePollingStatusJson) {
        content.livePollingStatusJson = patched;
        changed = true;
      }
    }
    if (content.skipPreRollAd === false) {
      content.skipPreRollAd = true;
      changed = true;
    }
    return changed;
  }

  function disableBooleanFlags(target, keys) {
    let changed = false;
    for (const key of keys) {
      if (hasOwn(target, key) && target[key] === true) {
        target[key] = false;
        changed = true;
      }
    }
    return changed;
  }

  function patchAdPolicy(content) {
    let changed = false;
    const current = content.playerAdDisplayResponse;
    if (isObject(current)) {
      changed = disableBooleanFlags(current, ["preRoll", "midRoll", "postRoll"]);
    }
    // seoraksan의 광고 응답에만 존재하는 boolean 쌍입니다.
    // 방송 ID/채팅 ID가 문자열 또는 숫자인 일반 재생 정보에는 손대지 않습니다.
    const disguised = content.livePlaybackJson;
    if (
      isObject(disguised) &&
      hasOwn(disguised, "liveId") &&
      hasOwn(disguised, "chatChannelId") &&
      typeof disguised.liveId === "boolean" &&
      typeof disguised.chatChannelId === "boolean"
    ) {
      changed = disableBooleanFlags(disguised, ["liveId", "chatChannelId"]) || changed;
    }
    return changed;
  }

  function patchText(text, kind) {
    if (typeof text !== "string") {
      return null;
    }
    try {
      const body = parse(text);
      if (!isObject(body) || body.code !== 200 || !isObject(body.content)) {
        return null;
      }
      const changed = kind === "adPolicy"
        ? patchAdPolicy(body.content)
        : patchLiveStatus(body.content);
      return changed ? stringify(body) : null;
    } catch {
      return null;
    }
  }

  function patchPublicPlayback(descriptor, checks) {
    // 현재 플레이어는 암호화된 meta 응답을 복호화한 뒤 이 JSON을 파싱합니다.
    // 이미 공급된 공개 HLS 주소만 사용하며 로그인/유료/종료 상태는 변경하지 않습니다.
    if (
      !isObject(descriptor) ||
      !isObject(descriptor.meta) ||
      !isObject(descriptor.serviceMeta) ||
      descriptor.serviceMeta.contentType !== "VIDEO" ||
      !isObject(descriptor.live) ||
      descriptor.live.status !== "STARTED" ||
      !Array.isArray(descriptor.media)
    ) {
      checks.add("descriptorRejected");
      return false;
    }
    if (descriptor.meta.paidLive !== false || descriptor.meta.playbackAuthType !== "NONE") {
      checks.add("entitlementRejected");
      return false;
    }

    function removeP2pPaths(target) {
      let changed = false;
      for (const key of ["p2pPath", "p2pPathUrlEncoding"]) {
        if (hasOwn(target, key) && typeof target[key] === "string") {
          delete target[key];
          changed = true;
        }
      }
      return changed;
    }

    let changed = false;
    let acceptedMedia = false;
    let rejectedMedia = false;
    if (descriptor.media.length === 0) {
      checks.add("mediaShapeRejected");
    }
    for (const media of descriptor.media) {
      if (
        !isObject(media) ||
        !["HLS", "LLHLS"].includes(media.mediaId) ||
        media.protocol !== "HLS" ||
        typeof media.path !== "string" ||
        !Array.isArray(media.encodingTrack)
      ) {
        checks.add("mediaShapeRejected");
        rejectedMedia = true;
        continue;
      }
      let url;
      try {
        url = new URL(media.path);
      } catch {
        checks.add("mediaUrlRejected");
        rejectedMedia = true;
        continue;
      }
      if (
        url.protocol !== "https:" ||
        url.port !== "" ||
        url.username !== "" ||
        url.password !== "" ||
        !url.pathname.endsWith(".m3u8")
      ) {
        checks.add("mediaUrlRejected");
        rejectedMedia = true;
        continue;
      }
      if (
        ![
          "nvelop-livecloud.pstatic.net",
          "livecloud.pstatic.net",
          "fcdn-livecloud.pstatic.net",
          "ex-nlive-streaming.navercdn.com",
        ].includes(url.hostname)
      ) {
        checks.add("mediaHostRejected");
        rejectedMedia = true;
        continue;
      }
      acceptedMedia = true;
      changed = removeP2pPaths(media) || changed;
      for (const track of media.encodingTrack) {
        if (isObject(track)) {
          changed = removeP2pPaths(track) || changed;
        }
      }
    }
    if (changed) {
      checks.add(rejectedMedia ? "partiallyPatched" : "fullyPatched");
    } else if (acceptedMedia) {
      checks.add("noP2pPaths");
    }
    return changed;
  }

  function installPlaybackParser() {
    try {
      const wrappedParse = new Proxy(parse, {
        apply(target, thisArg, args) {
          // 원래 파서/호출자 reviver의 반환값과 예외 동작을 우선 보존합니다.
          const result = Reflect.apply(target, thisArg, args);
          try {
            if (
              !filteringEnabled() ||
              typeof args[0] !== "string" ||
              (args.length > 1 && args[1] !== undefined) ||
              !args[0].includes('"p2pPath') ||
              !args[0].includes('"playbackAuthType"')
            ) {
              return result;
            }
            // native JSON.parse가 새로 만든 객체만 다룹니다. API 응답이나 인증값,
            // CDN 주소/토큰, 화질 목록, meta.p2p 등은 그대로 보존합니다.
            // 원본 주소/응답 값 대신 고정된 조건별 횟수만 남깁니다. 한 재생 정보에
            // 여러 미디어/트랙이 있어도 각 조건은 한 번만 세고 진단도 한 번 갱신합니다.
            const checks = new Set(["candidates"]);
            if (patchPublicPlayback(result, checks)) {
              diagnostics.counts.publicPlaybacks = Math.min(1_000_000, diagnostics.counts.publicPlaybacks + 1);
            }
            for (const name of checks) {
              diagnostics.playbackChecks[name] = Math.min(1_000_000, diagnostics.playbackChecks[name] + 1);
            }
            publishDiagnostics();
          } catch {
            // 알려지지 않은 재생 정보는 원래 파싱 결과를 사용합니다.
          }
          return result;
        },
      });
      JSON.parse = wrappedParse;
      diagnostics.installed.parser = JSON.parse === wrappedParse;
      activeChecks.parser = () => JSON.parse === wrappedParse;
    } catch {
      // JSON.parse를 덮어쓸 수 없는 환경에서는 API 응답 처리만 유지합니다.
    }
  }

  function installTunnelAdPolicy() {
    const subtle = window.crypto?.subtle;
    const nativeDecrypt = subtle?.decrypt;
    const NativeTextDecoder = window.TextDecoder;
    const NativeTextEncoder = window.TextEncoder;
    if (
      typeof nativeDecrypt !== "function" ||
      typeof NativeTextDecoder !== "function" ||
      typeof NativeTextEncoder !== "function"
    ) {
      return;
    }

    const prefix = new NativeTextEncoder().encode("gfp-tunnel-response-v1");
    const byteLengthGetter = Object.getOwnPropertyDescriptor(
      ArrayBuffer.prototype,
      "byteLength",
    ).get;

    function bytesOf(value) {
      if (ArrayBuffer.isView(value)) {
        return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      }
      // ArrayBuffer의 native getter로 확인하므로 다른 realm의 BufferSource도 지원합니다.
      const length = Reflect.apply(byteLengthGetter, value, []);
      return new Uint8Array(value, 0, length);
    }

    function isPolicyTunnel(algorithm) {
      if (!isObject(algorithm)) {
        return false;
      }
      // 임의 getter를 추가 호출하지 않고 이미 전달된 일반 데이터 속성만 검사합니다.
      const name = Object.getOwnPropertyDescriptor(algorithm, "name");
      const data = Object.getOwnPropertyDescriptor(algorithm, "additionalData");
      if (name?.value !== "AES-GCM" || !data || !("value" in data)) {
        return false;
      }
      const bytes = bytesOf(data.value);
      if (
        // 확인된 tunnel 응답 AAD: 2-byte 길이 + 22-byte 식별자 + 16-byte nonce.
        bytes.length !== prefix.length + 2 + 16 ||
        bytes[0] !== 0 ||
        bytes[1] !== prefix.length
      ) {
        return false;
      }
      return prefix.every((byte, index) => bytes[index + 2] === byte);
    }

    function exactKeys(value, keys) {
      return isObject(value) &&
        Object.keys(value).length === keys.length &&
        keys.every((key) => hasOwn(value, key));
    }

    function isVideoAdWaterfall(body) {
      if (
        !exactKeys(body, [
          "requestId", "head", "eventTracking", "adUnit", "randomNumber",
          "adDivId", "videoSkipMin", "videoSkipAfter", "ads",
        ]) ||
        !exactKeys(body.head, ["version", "description"]) ||
        body.head.version !== "0.0.1" ||
        body.head.description !== "Naver SSP Waterfall List" ||
        !isObject(body.eventTracking) ||
        !["requestId", "adUnit", "adDivId"].every((key) => typeof body[key] === "string") ||
        !["randomNumber", "videoSkipMin", "videoSkipAfter"].every((key) =>
          typeof body[key] === "number" && Number.isFinite(body[key])) ||
        !Array.isArray(body.ads) ||
        body.ads.length === 0
      ) {
        return false;
      }
      return body.ads.every((ad) =>
        isObject(ad) &&
        ["GV", "GOOGLE_IMA", "EMPTY"].includes(ad.renderType) &&
        ad.creativeType === "VIDEO" &&
        isObject(ad.adInfo));
    }

    function patchPolicyBytes(buffer) {
      const bytes = bytesOf(buffer);
      if (bytes.byteLength === 0 || bytes.byteLength > 65_536) {
        return buffer;
      }
      const body = parse(new NativeTextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (isVideoAdWaterfall(body)) {
        // 정책 응답 이후의 SDK 영상광고 후보를 별도로 처리합니다. 공식 SDK는 빈
        // 목록을 NO_FILL로 처리해 본방송을 이어갑니다. EMPTY 후보를 남기면 허위
        // 노출 알림을 발생시킬 수 있으므로 후보 전체만 비우고 메타데이터는 보존합니다.
        body.ads = [];
        const patched = new NativeTextEncoder().encode(stringify(body)).buffer;
        countPatch("waterfalls");
        return patched;
      }
      if (
        !exactKeys(body, ["code", "message", "content"]) ||
        body.code !== 200 ||
        body.message !== null ||
        !exactKeys(body.content, ["livePlaybackJson"]) ||
        !exactKeys(body.content.livePlaybackJson, ["liveId", "chatChannelId"])
      ) {
        return buffer;
      }
      const policy = body.content.livePlaybackJson;
      if (
        typeof policy.liveId !== "boolean" ||
        typeof policy.chatChannelId !== "boolean" ||
        (!policy.liveId && !policy.chatChannelId)
      ) {
        return buffer;
      }
      policy.liveId = false;
      policy.chatChannelId = false;
      const patched = new NativeTextEncoder().encode(stringify(body)).buffer;
      countPatch("adPolicies");
      return patched;
    }

    try {
      const wrappedDecrypt = new Proxy(nativeDecrypt, {
        apply(target, thisArg, args) {
          // 키/IV/암호문 및 this를 그대로 전달합니다. native 실패는 그대로 전파합니다.
          const operation = Reflect.apply(target, thisArg, args);
          try {
            if (!filteringEnabled() || !isPolicyTunnel(args[0])) {
              return operation;
            }
          } catch {
            return operation;
          }
          return operation.then((buffer) => {
            try {
              // 진행 중 OFF로 바뀐 요청에는 원본 ArrayBuffer를 반환합니다.
              return filteringEnabled() ? patchPolicyBytes(buffer) : buffer;
            } catch {
              // 광고 정책과 다른 JSON/바이너리, UTF-8 오류 등은 원본 그대로 둡니다.
              return buffer;
            }
          });
        },
      });
      subtle.decrypt = wrappedDecrypt;
      diagnostics.installed.tunnel = subtle.decrypt === wrappedDecrypt;
      activeChecks.tunnel = () => window.crypto?.subtle === subtle && subtle.decrypt === wrappedDecrypt;
    } catch {
      // WebCrypto 속성이 잠긴 경우 재생 JSON 및 일반 API 처리만 유지합니다.
    }
  }

  function installXhr() {
    const prototype = window.XMLHttpRequest?.prototype;
    if (!prototype || typeof prototype.open !== "function") {
      return;
    }
    const records = new WeakMap();
    const nativeOpen = prototype.open;
    const installedGetters = [];

    function readResponse(xhr, raw, property) {
      const record = records.get(xhr);
      if (
        !filteringEnabled() ||
        !record?.kind ||
        xhr.readyState !== 4 ||
        xhr.status < 200 ||
        xhr.status >= 300 ||
        (xhr.responseURL && targetKind(xhr.responseURL) !== record.kind)
      ) {
        return raw;
      }
      if (property === "responseText" || !xhr.responseType || xhr.responseType === "text") {
        if (record.textInput !== raw) {
          record.textInput = raw;
          const text = patchText(raw, record.kind);
          record.textOutput = text ?? raw;
          if (text !== null) {
            countPatch("apiPatches");
          }
        }
        return record.textOutput;
      }
      if (xhr.responseType === "json" && isObject(raw)) {
        if (record.jsonInput !== raw) {
          record.jsonInput = raw;
          record.jsonOutput = raw;
          // 파싱된 원본 객체를 변경하지 않습니다. 반복 접근에는 같은 객체를 반환합니다.
          const text = patchText(stringify(raw), record.kind);
          if (text !== null) {
            record.jsonOutput = parse(text);
            countPatch("apiPatches");
          }
        }
        return record.jsonOutput;
      }
      return raw;
    }

    for (const property of ["responseText", "response"]) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
      if (typeof descriptor?.get !== "function" || !descriptor.configurable) {
        continue;
      }
      const nativeGet = descriptor.get;
      try {
        const wrappedGet = function () {
          // 잘못된 responseType 접근의 브라우저 고유 예외는 유지합니다.
          const raw = Reflect.apply(nativeGet, this, []);
          try {
            return readResponse(this, raw, property);
          } catch {
            return raw;
          }
        };
        Object.defineProperty(prototype, property, { ...descriptor, get: wrappedGet });
        if (Object.getOwnPropertyDescriptor(prototype, property)?.get === wrappedGet) {
          installedGetters.push([property, wrappedGet]);
        }
      } catch {
        // 잠긴 getter는 그대로 둡니다.
      }
    }
    try {
      const wrappedOpen = new Proxy(nativeOpen, {
        apply(target, thisArg, args) {
          const result = Reflect.apply(target, thisArg, args);
          // XHR 인스턴스를 재사용해도 이전 응답이나 요청 범위가 남지 않습니다.
          records.set(thisArg, { kind: targetKind(args[1]) });
          return result;
        },
      });
      prototype.open = wrappedOpen;
      activeChecks.xhr = () => prototype.open === wrappedOpen && installedGetters.length === 2 &&
        installedGetters.every(([property, getter]) =>
          Object.getOwnPropertyDescriptor(prototype, property)?.get === getter);
      diagnostics.installed.xhr = activeChecks.xhr();
    } catch {
      // open을 바꿀 수 없으면 records가 비어 있으므로 원본 값이 반환됩니다.
    }
  }

  function installFetch() {
    const nativeFetch = window.fetch;
    const NativeResponse = window.Response;
    if (typeof nativeFetch !== "function" || typeof NativeResponse !== "function") {
      return;
    }

    function preserveMetadata(response, metadata) {
      const nativeClone = response.clone;
      Object.defineProperties(response, {
        url: { configurable: true, get: () => metadata.url },
        redirected: { configurable: true, get: () => metadata.redirected },
        type: { configurable: true, get: () => metadata.type },
        clone: {
          configurable: true,
          writable: true,
          value: function clone(...args) {
            return preserveMetadata(Reflect.apply(nativeClone, this, args), metadata);
          },
        },
      });
      return response;
    }

    try {
      const wrappedFetch = new Proxy(nativeFetch, {
        async apply(target, thisArg, args) {
          const response = await Reflect.apply(target, thisArg, args);
          try {
            const kind = targetKind(requestUrl(args[0]));
            if (
              !filteringEnabled() ||
              !kind ||
              !response.ok ||
              (response.url && targetKind(response.url) !== kind)
            ) {
              return response;
            }
            const text = patchText(await response.clone().text(), kind);
            if (text === null || !filteringEnabled()) {
              return response;
            }
            const rewritten = new NativeResponse(text, {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            });
            const patched = preserveMetadata(rewritten, {
              url: response.url,
              redirected: response.redirected,
              type: response.type,
            });
            countPatch("apiPatches");
            return patched;
          } catch {
            // 복제·파싱 실패 시 원본 본문을 소비하지 않고 그대로 반환합니다.
            return response;
          }
        },
      });
      window.fetch = wrappedFetch;
      diagnostics.installed.fetch = window.fetch === wrappedFetch;
      activeChecks.fetch = () => window.fetch === wrappedFetch;
    } catch {
      // 잠긴 fetch는 그대로 두고 XHR 처리는 유지합니다.
    }
  }

  for (const install of [installXhr, installFetch, installPlaybackParser, installTunnelAdPolicy]) {
    try {
      install();
    } catch {
      // 한 API를 처리할 수 없어도 다른 API 설치는 계속합니다.
    }
  }
  installDiagnostics();
})();
