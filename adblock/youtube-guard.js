(() => {
  const TARGET_NODE_NAME = "SCRIPT";
  const TARGET_TEXT = 'window,"fetch"';
  let observer = null;

  function makeEmptyScriptValue() {
    try {
      const trustedTypes = globalThis.trustedTypes;
      if (
        trustedTypes?.getPropertyType?.("script", "textContent") !==
          "TrustedScript" ||
        typeof trustedTypes.createPolicy !== "function"
      ) {
        return "";
      }

      const randomValues = new Uint32Array(2);
      globalThis.crypto?.getRandomValues?.(randomValues);
      const policyName = `lae-${randomValues[0].toString(36)}-${randomValues[1].toString(36)}`;
      return trustedTypes
        .createPolicy(policyName, { createScript: () => "" })
        .createScript("");
    } catch {
      return "";
    }
  }

  const emptyScriptValue = makeEmptyScriptValue();

  function neutralize(node) {
    if (
      node?.nodeName !== TARGET_NODE_NAME ||
      typeof node.textContent !== "string" ||
      !node.textContent.includes(TARGET_TEXT)
    ) {
      return;
    }

    try {
      node.textContent = emptyScriptValue;
    } catch {
      try {
        node.remove?.();
      } catch {
        // Parser가 이미 노드를 폐기한 경우에는 할 일이 없습니다.
      }
    }
  }

  function handleMutations(mutations) {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes ?? []) {
        neutralize(node);
      }
    }
  }

  function stop() {
    if (!observer) {
      return;
    }
    try {
      handleMutations(observer.takeRecords?.() ?? []);
    } catch {
      // 남은 mutation을 읽지 못해도 observer는 반드시 해제합니다.
    }
    observer.disconnect();
    observer = null;
  }

  if (typeof MutationObserver !== "function") {
    return;
  }

  observer = new MutationObserver(handleMutations);
  observer.observe(document, { childList: true, subtree: true });

  try {
    for (const script of document.querySelectorAll?.("script") ?? []) {
      if (script !== document.currentScript) {
        neutralize(script);
      }
    }
  } catch {
    // documentElement가 아직 생성되기 전이면 observer가 이후 노드를 처리합니다.
  }

  if (document.readyState !== "loading") {
    stop();
  } else {
    document.addEventListener?.(
      "readystatechange",
      () => {
        if (document.readyState !== "loading") {
          stop();
        }
      },
      { capture: true, once: true },
    );
  }
})();
