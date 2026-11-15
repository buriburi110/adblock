(() => {
  const STATE_ATTRIBUTE = "data-lae-player";
  const STATE_EVENT = "lae-player-state";
  const currentHost = window.location.hostname.toLowerCase();
  const useDesktopNetworkHooks = currentHost === "www.youtube.com";
  const useDeepResponseHooks = ["m.youtube.com", "music.youtube.com"].includes(
    currentHost,
  );
  const usePlayerXhrHook = useDesktopNetworkHooks || useDeepResponseHooks;
  const usePlacementMapHook = [
    "www.youtube.com",
    "music.youtube.com",
  ].includes(currentHost);

  const AD_FIELD_NAMES = new Set([
    "adBreakHeartbeatParams",
    "adPlacements",
    "adSlots",
    "playerAds",
  ]);
  const PLAYER_MARKER =
    /"(?:adBreakHeartbeatParams|adPlacements|adSlots|playerAds)"\s*:/;
  const SHORTS_ENDPOINT_MARKER = /"reelWatchEndpoint"\s*:/;
  const SHORTS_AD_MARKER = /"isAd"\s*:/;
  const PLAYER_ENDPOINT =
    /\/(?:youtubei\/v1\/player|get_watch|get_video_info)(?:[/?]|$)/;
  const PLAYER_RESPONSE_HOSTNAMES = new Set([
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "tv.youtube.com",
    "www.youtube-nocookie.com",
  ]);
  const YOUTUBE_HARD_WALL_SELECTOR = "ytd-enforcement-message-view-model";
  const MAX_SCANNED_OBJECTS = 10_000;
  const MAX_PENDING_ITEMS = 32;
  const MAX_WALL_RETRIES_PER_DOCUMENT = 16;
  const nativeJsonParse = JSON.parse;
  const nativeJsonStringify = JSON.stringify;
  const nativeArraySplice = Array.prototype.splice;
  const pendingObjects = [];
  const pendingObjectSet = new WeakSet();
  const pendingMapEntries = [];
  const playbackRecoveryRecords = new Map();

  function activationState() {
    const value = document.documentElement?.getAttribute(STATE_ATTRIBUTE);

    if (value === "on") {
      return true;
    }
    if (value === "off") {
      return false;
    }

    try {
      if (window.top === window) {
        return true;
      }
    } catch {
      // Cross-origin child frames wait for the isolated-world state bridge.
    }
    return null;
  }

  function isObject(value) {
    return value !== null && typeof value === "object";
  }

  function looksLikePlayerPayload(source) {
    return (
      PLAYER_MARKER.test(source) ||
      (SHORTS_ENDPOINT_MARKER.test(source) && SHORTS_AD_MARKER.test(source))
    );
  }

  function queuePendingObject(value) {
    if (
      !isObject(value) ||
      pendingObjectSet.has(value) ||
      pendingObjects.length >= MAX_PENDING_ITEMS
    ) {
      return;
    }

    pendingObjectSet.add(value);
    pendingObjects.push(value);
  }

  function hasOwnDataPath(value, path) {
    let current = value;

    for (const key of path) {
      if (!isObject(current)) {
        return false;
      }

      let descriptor;
      try {
        descriptor = Object.getOwnPropertyDescriptor(current, key);
      } catch {
        return false;
      }

      if (!descriptor || !("value" in descriptor)) {
        return false;
      }
      current = descriptor.value;
    }

    return true;
  }

  function pruneShortsAdEntries(value) {
    let entriesDescriptor;
    try {
      entriesDescriptor = Object.getOwnPropertyDescriptor(value, "entries");
    } catch {
      return;
    }

    const entries =
      entriesDescriptor && "value" in entriesDescriptor
        ? entriesDescriptor.value
        : null;
    if (!Array.isArray(entries)) {
      return;
    }

    const adMarkerPath = [
      "command",
      "reelWatchEndpoint",
      "adClientParams",
      "isAd",
    ];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      if (!hasOwnDataPath(entries[index], adMarkerPath)) {
        continue;
      }
      try {
        Reflect.apply(nativeArraySplice, entries, [index, 1]);
      } catch {
        // Frozen response arrays are left unchanged.
        return;
      }
    }
  }

  function prunePlayerData(value) {
    if (!isObject(value)) {
      return value;
    }

    const stack = [value];
    const visited = new WeakSet();
    let scanned = 0;

    while (stack.length && scanned < MAX_SCANNED_OBJECTS) {
      const current = stack.pop();

      if (!isObject(current) || visited.has(current)) {
        continue;
      }

      visited.add(current);
      scanned += 1;
      pruneShortsAdEntries(current);

      for (const fieldName of AD_FIELD_NAMES) {
        try {
          Reflect.deleteProperty(current, fieldName);
        } catch {
          // Frozen or cross-origin-shaped objects are left unchanged.
        }
      }

      let keys;
      try {
        keys = Object.keys(current);
      } catch {
        continue;
      }

      for (const key of keys) {
        let descriptor;
        try {
          descriptor = Object.getOwnPropertyDescriptor(current, key);
        } catch {
          continue;
        }

        if (!descriptor || !("value" in descriptor)) {
          continue;
        }

        const child = descriptor.value;
        if (isObject(child)) {
          if (key === "playerConfig") {
            try {
              Reflect.deleteProperty(child, "ssapConfig");
            } catch {
              // A read-only player configuration is left unchanged.
            }
          }
          stack.push(child);
          continue;
        }

        if (
          key === "raw_player_response" &&
          typeof child === "string" &&
          looksLikePlayerPayload(child)
        ) {
          try {
            const parsed = Reflect.apply(nativeJsonParse, JSON, [child]);
            prunePlayerData(parsed);
            current[key] = Reflect.apply(nativeJsonStringify, JSON, [parsed]);
          } catch {
            // Malformed or read-only payloads pass through untouched.
          }
        }
      }
    }

    return value;
  }

  function processCandidate(value) {
    const state = activationState();

    if (state === true) {
      return prunePlayerData(value);
    }
    if (state === null) {
      queuePendingObject(value);
    }
    return value;
  }

  function replaceMethod(owner, name, replacement) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(owner, name);
      if (!descriptor || (!("value" in descriptor) && !descriptor.configurable)) {
        return false;
      }
      if (descriptor && !descriptor.writable && !descriptor.configurable) {
        return false;
      }

      Object.defineProperty(owner, name, {
        ...descriptor,
        value: replacement,
      });
      return true;
    } catch {
      return false;
    }
  }

  function installJsonHook() {
    const proxy = new Proxy(nativeJsonParse, {
      apply(target, thisArgument, argumentsList) {
        const result = Reflect.apply(target, thisArgument, argumentsList);
        const source = argumentsList[0];

        if (typeof source === "string" && looksLikePlayerPayload(source)) {
          return processCandidate(result);
        }
        return result;
      },
    });

    replaceMethod(JSON, "parse", proxy);
  }

  function isPlayerEndpoint(url) {
    if (typeof url !== "string" && !(url instanceof String)) {
      return false;
    }

    try {
      const parsed = new URL(String(url), window.location.href);
      return (
        PLAYER_RESPONSE_HOSTNAMES.has(parsed.hostname.toLowerCase()) &&
        PLAYER_ENDPOINT.test(`${parsed.pathname}${parsed.search}`)
      );
    } catch {
      return false;
    }
  }

  function installResponseHook() {
    if (typeof Response !== "function" || !Response.prototype?.json) {
      return;
    }

    const nativeResponseJson = Response.prototype.json;
    const proxy = new Proxy(nativeResponseJson, {
      async apply(target, thisArgument, argumentsList) {
        const result = await Reflect.apply(target, thisArgument, argumentsList);

        if (isPlayerEndpoint(thisArgument?.url)) {
          return processCandidate(result);
        }
        return result;
      },
    });

    replaceMethod(Response.prototype, "json", proxy);
  }

  function installXhrHook() {
    if (typeof XMLHttpRequest !== "function" || !XMLHttpRequest.prototype?.open) {
      return;
    }

    const nativeOpen = XMLHttpRequest.prototype.open;
    const trackedUrls = new WeakMap();
    const observedRequests = new WeakSet();

    function inspectResponse() {
      if (this.readyState !== 4 || !isPlayerEndpoint(trackedUrls.get(this))) {
        return;
      }

      try {
        if (this.responseType === "json" && isObject(this.response)) {
          processCandidate(this.response);
        }
      } catch {
        // Access to a failed XHR response can throw.
      }
    }

    const proxy = new Proxy(nativeOpen, {
      apply(target, thisArgument, argumentsList) {
        const result = Reflect.apply(target, thisArgument, argumentsList);
        const requestUrl = String(argumentsList[1] ?? "");
        trackedUrls.set(thisArgument, requestUrl);

        if (
          isPlayerEndpoint(requestUrl) &&
          !observedRequests.has(thisArgument)
        ) {
          observedRequests.add(thisArgument);
          thisArgument.addEventListener("readystatechange", inspectResponse);
        }
        return result;
      },
    });

    replaceMethod(XMLHttpRequest.prototype, "open", proxy);
  }

  function installMapHook() {
    if (typeof Map !== "function" || !Map.prototype?.set) {
      return;
    }

    const nativeMapSet = Map.prototype.set;
    const proxy = new Proxy(nativeMapSet, {
      apply(target, thisArgument, argumentsList) {
        let kind;
        try {
          kind = argumentsList[1]?.kind;
        } catch {
          kind = undefined;
        }

        if (typeof kind === "string" && kind.startsWith("AD_PLACEMENT_KIND_")) {
          const state = activationState();
          if (state === true) {
            return thisArgument;
          }
          if (state === null && pendingMapEntries.length < MAX_PENDING_ITEMS) {
            pendingMapEntries.push({
              key: argumentsList[0],
              map: thisArgument,
              value: argumentsList[1],
            });
          }
        }

        return Reflect.apply(target, thisArgument, argumentsList);
      },
    });

    replaceMethod(Map.prototype, "set", proxy);
  }

  function installGlobalTrap(name) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(window, name);
    } catch {
      return;
    }

    if (descriptor && "value" in descriptor && descriptor.value !== undefined) {
      processCandidate(descriptor.value);
      return;
    }

    if (
      descriptor &&
      (!descriptor.configurable ||
        !("value" in descriptor) ||
        descriptor.writable === false)
    ) {
      try {
        processCandidate(window[name]);
      } catch {
        // 기존 accessor나 읽기 전용 전역은 모양을 바꾸지 않습니다.
      }
      return;
    }

    let storedValue = descriptor && "value" in descriptor
      ? descriptor.value
      : undefined;
    const dataDescriptor = {
      configurable: descriptor?.configurable ?? true,
      enumerable: descriptor?.enumerable ?? true,
      writable: descriptor?.writable ?? true,
    };

    try {
      Object.defineProperty(window, name, {
        configurable: true,
        enumerable: dataDescriptor.enumerable,
        get() {
          return storedValue;
        },
        set(value) {
          const processed = processCandidate(value);
          storedValue = processed;
          try {
            Object.defineProperty(window, name, {
              ...dataDescriptor,
              value: processed,
            });
          } catch {
            // 복원에 실패하면 저장된 값은 임시 accessor를 통해 계속 노출됩니다.
          }
        },
      });
      processCandidate(storedValue);
    } catch {
      // Leave globals with unusual descriptors unchanged.
    }
  }

  function installYoutubeDomBypassGuard() {
    const NodeConstructor = globalThis.Node;
    const HTMLElementConstructor = globalThis.HTMLElement;
    if (
      !useDesktopNetworkHooks ||
      typeof NodeConstructor !== "function" ||
      typeof HTMLElementConstructor !== "function" ||
      typeof NodeConstructor.prototype?.appendChild !== "function"
    ) {
      return;
    }

    const nativeAppendChild = NodeConstructor.prototype.appendChild;
    const proxy = new Proxy(nativeAppendChild, {
      apply(target, thisArgument, argumentsList) {
        const candidate = argumentsList[0];
        const result = Reflect.apply(target, thisArgument, argumentsList);

        if (
          activationState() !== true ||
          !(candidate instanceof HTMLElementConstructor)
        ) {
          return result;
        }

        try {
          const childWindow = candidate.contentWindow;
          const childHref = childWindow?.location?.href;
          if (
            !childWindow ||
            (childHref !== "about:blank" && childHref !== window.location.href)
          ) {
            return result;
          }

          if (typeof window.fetch === "function") {
            childWindow.fetch = window.fetch;
          }
          if (typeof window.Request === "function") {
            childWindow.Request = window.Request;
          }
          if (childWindow.JSON && typeof window.JSON?.parse === "function") {
            childWindow.JSON.parse = window.JSON.parse;
          }
        } catch {
          // 다른 origin으로 전환된 iframe이나 잠긴 속성은 그대로 둡니다.
        }

        return result;
      },
    });

    replaceMethod(NodeConstructor.prototype, "appendChild", proxy);
  }

  function processKnownGlobals() {
    const responseNames = useDeepResponseHooks
      ? ["ytInitialPlayerResponse", "playerResponse"]
      : ["ytInitialPlayerResponse"];

    for (const name of responseNames) {
      try {
        prunePlayerData(window[name]);
      } catch {
        // The other known player response may still be available.
      }
    }

    processLateRawPlayerResponse();
  }

  function processLateRawPlayerResponse() {
    let args;
    try {
      args = window.ytplayer?.config?.args;
    } catch {
      return;
    }
    if (!isObject(args)) {
      return;
    }

    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(args, "raw_player_response");
    } catch {
      return;
    }
    if (!descriptor || !("value" in descriptor)) {
      return;
    }

    const rawResponse = descriptor.value;
    if (isObject(rawResponse)) {
      processCandidate(rawResponse);
      return;
    }

    if (
      activationState() === true &&
      typeof rawResponse === "string" &&
      looksLikePlayerPayload(rawResponse)
    ) {
      try {
        const parsed = Reflect.apply(nativeJsonParse, JSON, [rawResponse]);
        prunePlayerData(parsed);
        args.raw_player_response = Reflect.apply(nativeJsonStringify, JSON, [
          parsed,
        ]);
      } catch {
        // Malformed or read-only payloads pass through untouched.
      }
    }
  }

  function currentWatchVideoId() {
    try {
      if (window.top !== window) {
        return "";
      }
      const url = new URL(window.location.href);
      if (
        !["youtube.com", "www.youtube.com"].includes(url.hostname) ||
        url.pathname !== "/watch"
      ) {
        return "";
      }
      const videoId = url.searchParams.get("v") ?? "";
      return /^[A-Za-z0-9_-]{6,20}$/.test(videoId) ? videoId : "";
    } catch {
      return "";
    }
  }

  function isVisibleHardWall(wall) {
    if (
      !wall ||
      wall.isConnected === false ||
      wall.hidden === true ||
      wall.hasAttribute?.("hidden") ||
      wall.getAttribute?.("aria-hidden") === "true"
    ) {
      return false;
    }

    try {
      if (typeof wall.checkVisibility === "function" && !wall.checkVisibility()) {
        return false;
      }
    } catch {
      return false;
    }

    try {
      const dismissButton = wall.querySelector?.("#dismiss-button");
      if (
        dismissButton &&
        dismissButton.isConnected !== false &&
        !dismissButton.disabled &&
        dismissButton.getAttribute?.("aria-hidden") !== "true"
      ) {
        return false;
      }
    } catch {
      // 버튼 구조를 읽지 못해도 exact wall 신호는 계속 검사합니다.
    }

    return true;
  }

  function hasServer3037019Signature(root) {
    if (!isObject(root)) {
      return false;
    }

    const supportUrl = "https://support.google.com/youtube/answer/3037019";
    const stack = [root];
    const visited = new WeakSet();
    let foundPageType = false;
    let foundSupportUrl = false;
    let scanned = 0;

    while (stack.length && scanned < 256) {
      const current = stack.pop();
      if (!isObject(current) || visited.has(current)) {
        continue;
      }
      visited.add(current);
      scanned += 1;

      let descriptors;
      try {
        descriptors = Object.getOwnPropertyDescriptors(current);
      } catch {
        continue;
      }

      for (const descriptor of Object.values(descriptors)) {
        if (!("value" in descriptor)) {
          continue;
        }
        const value = descriptor.value;
        if (value === "WEB_PAGE_TYPE_UNKNOWN") {
          foundPageType = true;
        } else if (
          typeof value === "string" &&
          (value === supportUrl || value.startsWith(`${supportUrl}?`))
        ) {
          foundSupportUrl = true;
        } else if (isObject(value)) {
          stack.push(value);
        }
      }

      if (foundPageType && foundSupportUrl) {
        return true;
      }
    }

    return false;
  }

  function normalizedPlaybackStart(playerResponse, player) {
    let start = Number(player?.getProgressState?.()?.current);
    if (!Number.isFinite(start) || start < 0) {
      start = Number(
        playerResponse?.playerConfig?.playbackStartConfig?.startSeconds,
      );
    }
    if (!Number.isFinite(start) || start < 0) {
      start = 0;
    }

    const duration = Number(player?.getProgressState?.()?.duration);
    if (Number.isFinite(duration) && duration > 1 && start >= duration) {
      start = duration - 1;
    }
    return start;
  }

  function classifyBlockedPlayback() {
    if (
      activationState() !== true ||
      typeof document.querySelector !== "function"
    ) {
      return null;
    }

    const videoId = currentWatchVideoId();
    if (!videoId) {
      return null;
    }

    const player = document.querySelector("#movie_player");
    if (!player || typeof player.loadVideoById !== "function") {
      return null;
    }

    let playerResponse;
    try {
      playerResponse = player.getPlayerResponse?.();
    } catch {
      return null;
    }

    if (
      playerResponse?.videoDetails?.videoId !== videoId ||
      playerResponse.videoDetails?.isLive === true ||
      playerResponse.videoDetails?.isLiveContent === true ||
      player.classList?.contains("ad-showing") ||
      player.classList?.contains("ad-interrupting")
    ) {
      return null;
    }

    try {
      if (player.querySelector?.("video")?.ended === true) {
        return null;
      }
      if (player.getStatsForNerds?.()?.debug_info?.startsWith?.("SSAP, AD")) {
        return null;
      }
    } catch {
      return null;
    }

    const playabilityStatus = playerResponse.playabilityStatus;
    const status = playabilityStatus?.status;
    const errorScreen = playabilityStatus?.errorScreen;
    const captcha = errorScreen?.playerErrorMessageRenderer?.playerCaptchaViewModel;
    const wall = document.querySelector(YOUTUBE_HARD_WALL_SELECTOR);

    if (
      isVisibleHardWall(wall) &&
      !captcha &&
      (status === "OK" || status === "UNPLAYABLE")
    ) {
      return {
        kind: "terms-wall",
        player,
        startSeconds: normalizedPlaybackStart(playerResponse, player),
        videoId,
      };
    }

    if (status !== "UNPLAYABLE" || captcha) {
      return null;
    }

    const possibleSignatures = [
      errorScreen?.playerErrorMessageRenderer?.subreason?.runs,
      errorScreen?.playerInterstitialRenderer?.content?.interstitialViewModel
        ?.description?.commandRuns,
    ];
    if (!possibleSignatures.some(hasServer3037019Signature)) {
      return null;
    }

    return {
      kind: "server-3037019",
      player,
      startSeconds: normalizedPlaybackStart(playerResponse, player),
      videoId,
    };
  }

  function scheduleBlockedPlaybackRecovery() {
    const candidate = classifyBlockedPlayback();
    if (!candidate || playbackRecoveryRecords.has(candidate.videoId)) {
      return;
    }

    if (playbackRecoveryRecords.size >= MAX_WALL_RETRIES_PER_DOCUMENT) {
      const oldestVideoId = playbackRecoveryRecords.keys().next().value;
      playbackRecoveryRecords.delete(oldestVideoId);
    }

    const record = { kind: candidate.kind, state: "probing" };
    playbackRecoveryRecords.set(candidate.videoId, record);

    const verifyAndRetry = () => {
      const current = classifyBlockedPlayback();
      if (
        playbackRecoveryRecords.get(candidate.videoId) !== record ||
        !current ||
        current.videoId !== candidate.videoId ||
        current.kind !== candidate.kind
      ) {
        playbackRecoveryRecords.delete(candidate.videoId);
        return;
      }

      record.state = "attempted";
      try {
        current.player.loadVideoById(current.videoId, current.startSeconds);
      } catch {
        record.state = "failed";
      }
    };

    if (typeof globalThis.setTimeout === "function") {
      globalThis.setTimeout(verifyAndRetry, 150);
    } else {
      queueMicrotask(verifyAndRetry);
    }
  }

  function clickElement(element) {
    if (
      !element ||
      element.disabled ||
      element.isConnected === false ||
      element.getAttribute?.("aria-hidden") === "true"
    ) {
      return false;
    }

    try {
      const nativeClick = globalThis.HTMLElement?.prototype?.click;
      if (typeof nativeClick === "function") {
        Reflect.apply(nativeClick, element, []);
      } else if (typeof element.click === "function") {
        element.click();
      }
      return true;
    } catch {
      // A detached button can disappear between query and click.
      return false;
    }
  }

  function skipCurrentAd() {
    if (activationState() !== true || typeof document.querySelector !== "function") {
      return;
    }

    const player = document.querySelector("#movie_player");
    const adIsInterrupting = player?.classList?.contains("ad-interrupting");
    const adIsPlaying =
      adIsInterrupting || player?.classList?.contains("ad-showing");

    if (!adIsPlaying) {
      return;
    }

    if (adIsInterrupting) {
      try {
        const video =
          player?.querySelector?.("video") ??
          document.querySelector("#movie_player video");
        const duration = Number(video?.duration);
        const currentTime = Number(video?.currentTime);

        if (
          Number.isFinite(duration) &&
          duration > 0 &&
          (!Number.isFinite(currentTime) || currentTime < duration)
        ) {
          video.currentTime = duration;
        }
      } catch {
        // YouTube가 광고 전환 중 video 요소를 교체하면 다음 관찰에서 재시도합니다.
      }
    }

    const selectors = [
      "button.ytp-skip-ad-button",
      "button.ytp-skip-ad-button-modern",
      "button.ytp-ad-skip-button-modern",
      ".ytp-ad-skip-button-container button",
      "button.ytp-ad-overlay-close-button",
    ];
    const queryScope =
      typeof player?.querySelectorAll === "function" ? player : document;

    for (const selector of selectors) {
      let elements = [];
      try {
        elements = queryScope.querySelectorAll(selector);
      } catch {
        continue;
      }
      for (const element of elements) {
        if (clickElement(element)) {
          return;
        }
      }
    }
  }

  let domObserver = null;
  let observedTarget = null;
  let domWorkScheduled = false;

  function connectDomObserver() {
    if (!domObserver || typeof document.querySelector !== "function") {
      return;
    }

    const player = document.querySelector("#movie_player");
    const nextTarget = player ?? document.documentElement;
    if (!nextTarget || nextTarget === observedTarget) {
      return;
    }

    domObserver.disconnect();
    observedTarget = nextTarget;
    domObserver.observe(nextTarget, player
      ? {
          attributeFilter: ["class"],
          attributes: true,
          childList: true,
          subtree: true,
        }
      : { childList: true, subtree: true });
  }

  function scheduleDomWork() {
    if (domWorkScheduled) {
      return;
    }

    domWorkScheduled = true;
    queueMicrotask(() => {
      domWorkScheduled = false;
      if (activationState() === true) {
        // ytplayer.config는 초기 스크립트가 실행된 뒤 늦게 만들어질 수 있습니다.
        // 전역 prototype을 추가로 바꾸지 않고 정확한 raw 응답만 다시 확인합니다.
        processLateRawPlayerResponse();
      }
      connectDomObserver();
      scheduleBlockedPlaybackRecovery();
      skipCurrentAd();
    });
  }

  function handleStateChange() {
    const state = activationState();

    if (state === true) {
      for (const candidate of pendingObjects.splice(0)) {
        prunePlayerData(candidate);
      }
      for (const { key, map, value } of pendingMapEntries.splice(0)) {
        try {
          if (map.get(key) === value) {
            map.delete(key);
          }
        } catch {
          // A queued Map can be discarded before settings arrive.
        }
      }
      processKnownGlobals();
    } else if (state === false) {
      pendingObjects.length = 0;
      pendingMapEntries.length = 0;
    }

    scheduleDomWork();
  }

  if (useDeepResponseHooks) {
    installJsonHook();
  }
  if (usePlayerXhrHook) {
    installResponseHook();
    installXhrHook();
  }
  installYoutubeDomBypassGuard();
  if (usePlacementMapHook) {
    installMapHook();
  }
  installGlobalTrap("ytInitialPlayerResponse");
  if (useDeepResponseHooks) {
    installGlobalTrap("playerResponse");
  }

  if (typeof MutationObserver === "function") {
    domObserver = new MutationObserver(scheduleDomWork);
  }

  document.addEventListener?.(STATE_EVENT, handleStateChange);
  document.addEventListener?.("readystatechange", scheduleDomWork);
  document.addEventListener?.("yt-navigate-finish", scheduleDomWork, true);
  document.addEventListener?.("yt-page-data-updated", scheduleDomWork, true);
  setInterval?.(scheduleDomWork, 1_000);

  handleStateChange();
})();
