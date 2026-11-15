// SOOP VOD의 재생 정보에서 광고 설정 data.adballoon만 제거합니다.
// List-KR의 json-prune-xhr-response 규칙을 참고한 독립 구현입니다.
(() => {
  if (location.hostname !== "vod.sooplive.com") {
    return;
  }

  const INSTALL_KEY = Symbol.for("lae.soop.adballoon.v1");
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
  const targetHost = "api.m.sooplive.com";
  const targetPath = "/station/video/a/view";

  function filteringEnabled() {
    // content.js가 기존 탭에도 전체/사이트 OFF를 전달합니다. document_start의
    // 초기 상태는 아직 속성이 없을 수 있으므로 동적 등록의 ON 결정을 따릅니다.
    return document.documentElement?.getAttribute("data-lae-player") !== "off";
  }

  function isTarget(value) {
    try {
      const url = new URL(value, location.href);
      return (
        url.protocol === "https:" &&
        url.hostname === targetHost &&
        url.port === "" &&
        url.pathname === targetPath
      );
    } catch {
      return false;
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

  function pruneText(text) {
    if (typeof text !== "string") {
      return null;
    }
    try {
      const body = parse(text);
      const data = body?.data;
      if (
        !data ||
        typeof data !== "object" ||
        Array.isArray(data) ||
        !hasOwn(data, "adballoon")
      ) {
        return null;
      }
      delete data.adballoon;
      return stringify(body);
    } catch {
      return null;
    }
  }

  function installXhr() {
    const prototype = window.XMLHttpRequest?.prototype;
    if (!prototype || typeof prototype.open !== "function") {
      return;
    }

    const records = new WeakMap();
    const nativeOpen = prototype.open;

    function readResponse(xhr, raw, property) {
      const record = records.get(xhr);
      if (
        !filteringEnabled() ||
        !record?.target ||
        xhr.readyState !== 4 ||
        xhr.status < 200 ||
        xhr.status >= 300 ||
        (xhr.responseURL && !isTarget(xhr.responseURL))
      ) {
        return raw;
      }

      if (
        property === "responseText" ||
        !xhr.responseType ||
        xhr.responseType === "text"
      ) {
        if (record.textInput !== raw) {
          record.textInput = raw;
          record.textOutput = pruneText(raw) ?? raw;
        }
        return record.textOutput;
      }

      if (xhr.responseType === "json" && raw && typeof raw === "object") {
        if (record.jsonInput !== raw) {
          record.jsonInput = raw;
          record.jsonOutput = raw;
          // 원본 JSON 객체는 변경하지 않고, 반복 접근에는 같은 결과 객체를 돌려줍니다.
          const text = pruneText(stringify(raw));
          if (text !== null) {
            record.jsonOutput = parse(text);
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
        Object.defineProperty(prototype, property, {
          ...descriptor,
          get: function () {
            // responseType 불일치 등의 브라우저 고유 예외는 그대로 유지합니다.
            const raw = Reflect.apply(nativeGet, this, []);
            try {
              return readResponse(this, raw, property);
            } catch {
              return raw;
            }
          },
        });
      } catch {
        // 이미 잠긴 getter는 그대로 둡니다.
      }
    }

    try {
      prototype.open = new Proxy(nativeOpen, {
        apply(target, thisArg, args) {
          const result = Reflect.apply(target, thisArg, args);
          // 재사용된 XHR도 매 open마다 응답 캐시를 새로 만듭니다.
          records.set(thisArg, { target: isTarget(args[1]) });
          return result;
        },
      });
    } catch {
      // open을 덮어쓸 수 없으면 getter도 원래 값을 그대로 반환합니다.
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
            return preserveMetadata(
              Reflect.apply(nativeClone, this, args),
              metadata,
            );
          },
        },
      });
      return response;
    }

    try {
      window.fetch = new Proxy(nativeFetch, {
        async apply(target, thisArg, args) {
          const response = await Reflect.apply(target, thisArg, args);
          try {
            if (
              !filteringEnabled() ||
              !isTarget(requestUrl(args[0])) ||
              !response.ok ||
              (response.url && !isTarget(response.url))
            ) {
              return response;
            }
            const text = pruneText(await response.clone().text());
            if (text === null || !filteringEnabled()) {
              return response;
            }

            const rewritten = new NativeResponse(text, {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            });
            return preserveMetadata(rewritten, {
              url: response.url,
              redirected: response.redirected,
              type: response.type,
            });
          } catch {
            // JSON 파싱·복제 실패 시 원본 본문을 소비하지 않은 응답을 반환합니다.
            return response;
          }
        },
      });
    } catch {
      // fetch가 잠긴 환경에서는 XHR 처리를 유지합니다.
    }
  }

  for (const install of [installXhr, installFetch]) {
    try {
      install();
    } catch {
      // 어느 한 API의 속성을 조회할 수 없어도 다른 API 설치는 계속합니다.
    }
  }
})();
