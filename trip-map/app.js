(() => {
  "use strict";

  const MAX_FRAGMENT_LENGTH = 750_000;
  const MAX_DECODED_BYTES = 5_000_000;
  const DEFAULT_NEAR_HOTEL_RADIUS_KM = 2.5;
  const DEFAULT_VIEW = { lat: 20, lng: 0 };
  const DEFAULT_ZOOM = 2;
  const SHARE_FORMAT_VERSION = "v2";
  const SHARE_ADDITIONAL_DATA_PREFIX = "trip-map:v2";
  const MAP_STYLE_URL = "https://tiles.openfreemap.org/styles/liberty";
  const MAPLIBRE_WORKER_URL = "./vendor/maplibre/maplibre-gl-worker.js";

  const elements = {
    tripTitle: document.querySelector("#trip-title"),
    tripDates: document.querySelector("#trip-dates"),
    hotelButton: document.querySelector("#hotel-button"),
    shareButton: document.querySelector("#share-button"),
    copyLinkButton: document.querySelector("#copy-link-button"),
    shareStatus: document.querySelector("#share-status"),
    viewTabs: document.querySelector("#view-tabs"),
    viewButtons: Array.from(document.querySelectorAll("[data-view]")),
    filterBar: document.querySelector("#filter-bar"),
    filterButtons: Array.from(document.querySelectorAll("[data-filter]")),
    mapStage: document.querySelector("#map-stage"),
    daysStage: document.querySelector("#days-stage"),
    statePanel: document.querySelector("#state-panel"),
    stateTitle: document.querySelector("#state-title"),
    stateMessage: document.querySelector("#state-message"),
    mapActionStack: document.querySelector("#map-action-stack"),
    fitButton: document.querySelector("#fit-button"),
    locationButton: document.querySelector("#location-button"),
    dayMapBanner: document.querySelector("#day-map-banner"),
    dayMapTitle: document.querySelector("#day-map-title"),
    clearDayButton: document.querySelector("#clear-day-button"),
    showDayMapButton: document.querySelector("#show-day-map-button"),
    dayTabs: document.querySelector("#day-tabs"),
    dayPlanTitle: document.querySelector("#day-plan-title"),
    dayPlaceCount: document.querySelector("#day-place-count"),
    dayPlaceList: document.querySelector("#day-place-list"),
    clustersSection: document.querySelector("#clusters-section"),
    clusterList: document.querySelector("#cluster-list"),
    resultStatus: document.querySelector("#result-status"),
    sheet: document.querySelector("#detail-sheet"),
    sheetBackdrop: document.querySelector("#sheet-backdrop"),
    sheetClose: document.querySelector("#sheet-close"),
    detailContent: document.querySelector("#detail-content"),
  };

  let map = null;
  let tripData = null;
  let hotelMarker = null;
  let placeMarkers = new Map();
  let currentLocationMarker = null;
  let selectedMarkerElement = null;
  let activeFilter = "all";
  let activeView = "map";
  let dayDefinitions = [];
  let assignments = new Map();
  let selectedDayKey = null;
  let clusters = [];
  let lastFocusedElement = null;
  let loadSequence = 0;
  let shareStatusTimer = null;
  let mapInitializationError = "سرویس نقشه رایگان بارگذاری نشد.";

  const filterTests = {
    all: () => true,
    important: (place) => hasAnyCategory(place, ["important", "very-important", "very important"]) || place.priority === "high",
    free: (place) => hasAnyCategory(place, ["free", "free-entry", "free entry"]) || place.adultPrice === 0,
    booking: (place) => place.bookingRequired === true || hasAnyCategory(place, ["booking-required", "booking required", "booking-recommended", "booking recommended", "booking-related", "booking related"]),
    child: (place) => place.childFriendly === true,
    evening: (place) => hasAnyCategory(place, ["evening", "night", "nighttime"]),
    "near-hotel": (place) => isNearHotel(place),
  };

  function initializeMap() {
    if (!window.maplibregl?.Map) {
      throw new Error("کتابخانه نقشه بارگذاری نشد.");
    }
    window.maplibregl.setWorkerUrl(MAPLIBRE_WORKER_URL);
    map = new window.maplibregl.Map({
      container: "map",
      style: MAP_STYLE_URL,
      center: [DEFAULT_VIEW.lng, DEFAULT_VIEW.lat],
      zoom: DEFAULT_ZOOM,
      minZoom: 2,
      maxPitch: 60,
      pitchWithRotate: true,
      dragRotate: true,
      touchPitch: true,
      renderWorldCopies: true,
      attributionControl: false,
      antialias: true,
    });
    map.addControl(new window.maplibregl.NavigationControl({
      showCompass: true,
      showZoom: true,
      visualizePitch: true,
    }), "bottom-left");
    map.addControl(new window.maplibregl.FullscreenControl(), "top-left");
    map.addControl(new window.maplibregl.AttributionControl({ compact: true }), "bottom-left");
    map.on("moveend", updateMarkerCalloutSides);
    map.on("resize", updateMarkerCalloutSides);

    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timeout);
        map.off("style.load", finish);
        map.off("load", finish);
        resolve();
      };
      const timeout = window.setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error("سرویس نقشه رایگان پاسخ نداد."));
        }
      }, 20_000);
      map.once("style.load", finish);
      map.once("load", finish);
      if (map.isStyleLoaded()) {
        window.queueMicrotask(finish);
      }
    });
  }

  function isPlainObject(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }

  function isNonEmptyString(value, maxLength = 500) {
    return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
  }

  function isOptionalString(value, maxLength = 2_000) {
    return value === undefined || value === null || (typeof value === "string" && value.length <= maxLength);
  }

  function isOptionalDisplayValue(value, maxLength = 200) {
    return value === undefined
      || value === null
      || (typeof value === "string" && value.length <= maxLength)
      || (Number.isFinite(value) && Math.abs(value) <= 1_000_000_000);
  }

  function isCoordinate(value, type) {
    return Number.isFinite(value) && (type === "lat" ? value >= -90 && value <= 90 : value >= -180 && value <= 180);
  }

  function isIsoDate(value) {
    if (!isNonEmptyString(value, 10) || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return false;
    }
    const date = new Date(`${value}T12:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }

  function validateLocation(location, label) {
    if (!isPlainObject(location)) {
      throw new Error(`${label} معتبر نیست.`);
    }

    if (!isCoordinate(location.latitude, "lat") || !isCoordinate(location.longitude, "lng")) {
      throw new Error(`مختصات ${label} معتبر نیست.`);
    }

    const hasName = isNonEmptyString(location.nameFa, 160) || isNonEmptyString(location.nameOriginal, 160);
    if (!hasName) {
      throw new Error(`${label} باید نام داشته باشد.`);
    }

    const optionalTextFields = [
      "nameFa",
      "nameOriginal",
      "descriptionFa",
      "duration",
      "bookingUrgency",
      "planningNotes",
      "officialUrl",
      "ticketUrl",
      "icon",
    ];

    for (const field of optionalTextFields) {
      if (!isOptionalString(location[field])) {
        throw new Error(`فیلد ${field} در ${label} معتبر نیست.`);
      }
    }

    if (!isOptionalDisplayValue(location.adultPrice) || !isOptionalDisplayValue(location.childPrice)) {
      throw new Error(`قیمت در ${label} معتبر نیست.`);
    }

    return location;
  }

  function validateTripPayload(payload) {
    if (!isPlainObject(payload) || payload.version !== 1) {
      throw new Error("نسخه لینک پشتیبانی نمی‌شود.");
    }

    if (!isPlainObject(payload.trip) || !isNonEmptyString(payload.trip.title, 160)) {
      throw new Error("عنوان سفر معتبر نیست.");
    }

    if (!isOptionalString(payload.trip.startDate, 32) || !isOptionalString(payload.trip.endDate, 32)) {
      throw new Error("تاریخ سفر معتبر نیست.");
    }

    if ((payload.trip.startDate && !isIsoDate(payload.trip.startDate)) || (payload.trip.endDate && !isIsoDate(payload.trip.endDate))) {
      throw new Error("تاریخ سفر معتبر نیست.");
    }

    validateLocation(payload.hotel, "هتل");

    if (!Array.isArray(payload.places) || payload.places.length > 500) {
      throw new Error("فهرست مکان‌ها معتبر نیست.");
    }

    const ids = new Set();
    for (const place of payload.places) {
      validateLocation(place, "مکان");
      if (!isNonEmptyString(place.id, 100) || ids.has(place.id)) {
        throw new Error("شناسه مکان معتبر یا یکتا نیست.");
      }
      ids.add(place.id);

      if (place.categories !== undefined && (!Array.isArray(place.categories) || place.categories.some((item) => !isNonEmptyString(item, 80)))) {
        throw new Error("دسته‌بندی مکان معتبر نیست.");
      }

      if (place.category !== undefined && !isOptionalString(place.category, 80)) {
        throw new Error("دسته‌بندی مکان معتبر نیست.");
      }

      if (place.nearbyPlaceIds !== undefined && (!Array.isArray(place.nearbyPlaceIds) || place.nearbyPlaceIds.some((id) => !isNonEmptyString(id, 100)))) {
        throw new Error("مکان‌های نزدیک معتبر نیستند.");
      }

      if (place.minimumAge !== undefined && place.minimumAge !== null && (!Number.isFinite(place.minimumAge) || place.minimumAge < 0 || place.minimumAge > 120)) {
        throw new Error("حداقل سن معتبر نیست.");
      }

      if (place.childFriendly !== undefined && typeof place.childFriendly !== "boolean") {
        throw new Error("وضعیت مناسب‌بودن برای کودک معتبر نیست.");
      }

      if (place.bookingRequired !== undefined && typeof place.bookingRequired !== "boolean") {
        throw new Error("وضعیت رزرو معتبر نیست.");
      }
    }

    for (const place of payload.places) {
      if (Array.isArray(place.nearbyPlaceIds) && place.nearbyPlaceIds.some((id) => !ids.has(id) || id === place.id)) {
        throw new Error("ارجاع مکان نزدیک معتبر نیست.");
      }
    }

    if (payload.days !== undefined && (!Array.isArray(payload.days) || payload.days.length > 31)) {
      throw new Error("فهرست روزها معتبر نیست.");
    }

    const dayKeys = new Set();
    const assignedPlaces = new Set();
    for (const day of payload.days || []) {
      if (!isPlainObject(day) || !isIsoDate(day.date) || dayKeys.has(day.date)) {
        throw new Error("روز سفر معتبر یا یکتا نیست.");
      }
      dayKeys.add(day.date);
      if (!isOptionalString(day.labelFa, 100)) {
        throw new Error("عنوان روز سفر معتبر نیست.");
      }
      if (!Array.isArray(day.placeIds) || day.placeIds.some((id) => !ids.has(id))) {
        throw new Error("مکان‌های روز سفر معتبر نیستند.");
      }
      for (const id of day.placeIds) {
        if (assignedPlaces.has(id)) {
          throw new Error("یک مکان به بیش از یک روز اختصاص داده شده است.");
        }
        assignedPlaces.add(id);
      }
    }

    if (payload.clusters !== undefined && (!Array.isArray(payload.clusters) || payload.clusters.length > 50)) {
      throw new Error("گروه‌های نزدیک معتبر نیستند.");
    }

    const clusterIds = new Set();
    const clusteredPlaces = new Set();
    for (const cluster of payload.clusters || []) {
      if (!isPlainObject(cluster) || !isNonEmptyString(cluster.id, 100) || clusterIds.has(cluster.id)) {
        throw new Error("شناسه گروه نزدیک معتبر یا یکتا نیست.");
      }
      clusterIds.add(cluster.id);
      if (!isNonEmptyString(cluster.nameFa, 160) && !isNonEmptyString(cluster.nameOriginal, 160)) {
        throw new Error("گروه نزدیک باید نام داشته باشد.");
      }
      if (!isOptionalString(cluster.nameFa, 160) || !isOptionalString(cluster.nameOriginal, 160) || !isOptionalString(cluster.planningHintFa, 500)) {
        throw new Error("اطلاعات گروه نزدیک معتبر نیست.");
      }
      if (!Array.isArray(cluster.placeIds)
        || cluster.placeIds.length < 2
        || new Set(cluster.placeIds).size !== cluster.placeIds.length
        || cluster.placeIds.some((id) => !ids.has(id) || clusteredPlaces.has(id))) {
        throw new Error("مکان‌های گروه نزدیک معتبر نیستند.");
      }
      cluster.placeIds.forEach((id) => clusteredPlaces.add(id));
    }

    return payload;
  }

  function base64UrlToBytes(encoded) {
    if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
      throw new Error("داده لینک معتبر نیست.");
    }
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = window.atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  function bytesToBase64Url(bytes) {
    let binary = "";
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    return window.btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
  }

  function parseJsonBytes(bytes) {
    if (bytes.length > MAX_DECODED_BYTES) {
      throw new Error("داده لینک بیش از حد بزرگ است.");
    }
    const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(json);
  }

  async function readStreamWithLimit(stream, maximumBytes = MAX_DECODED_BYTES) {
    const reader = stream.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error("داده لینک بیش از حد بزرگ است.");
      }
      chunks.push(value);
    }
    const output = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  }

  async function decodeEncryptedFragment(fragment) {
    const parts = fragment.split(".");
    if (parts.length !== 5 || parts[0] !== SHARE_FORMAT_VERSION || !["g", "n"].includes(parts[1])) {
      throw new Error("ساختار لینک معتبر نیست.");
    }
    if (!window.crypto?.subtle) {
      throw new Error("این مرورگر امکان بازکردن لینک رمزگذاری‌شده را ندارد.");
    }

    const [, compressionMode, encodedKey, encodedIv, encodedCiphertext] = parts;
    const keyBytes = base64UrlToBytes(encodedKey);
    const iv = base64UrlToBytes(encodedIv);
    const ciphertext = base64UrlToBytes(encodedCiphertext);
    if (keyBytes.length !== 32 || iv.length !== 12 || ciphertext.length < 17) {
      throw new Error("داده رمزگذاری‌شده معتبر نیست.");
    }

    try {
      const key = await window.crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
      const decrypted = new Uint8Array(await window.crypto.subtle.decrypt({
        name: "AES-GCM",
        iv,
        additionalData: new TextEncoder().encode(`${SHARE_ADDITIONAL_DATA_PREFIX}:${compressionMode}`),
      }, key, ciphertext));

      let jsonBytes = decrypted;
      if (compressionMode === "g") {
        if (!("DecompressionStream" in window)) {
          throw new Error("این مرورگر امکان بازکردن لینک فشرده را ندارد.");
        }
        const decompressedStream = new Blob([decrypted])
          .stream()
          .pipeThrough(new DecompressionStream("gzip"));
        jsonBytes = await readStreamWithLimit(decompressedStream);
      }
      return validateTripPayload(parseJsonBytes(jsonBytes));
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("این مرورگر")) {
        throw error;
      }
      throw new Error("داده لینک قابل خواندن نیست.");
    }
  }

  async function decodeFragment() {
    const fragment = window.location.hash.slice(1);
    if (!fragment) {
      return null;
    }

    if (fragment.length > MAX_FRAGMENT_LENGTH) {
      throw new Error("ساختار لینک معتبر نیست.");
    }

    if (fragment.startsWith(`${SHARE_FORMAT_VERSION}.`)) {
      return decodeEncryptedFragment(fragment);
    }

    if (!fragment.startsWith("v1.")) {
      throw new Error("ساختار لینک معتبر نیست.");
    }

    const encoded = fragment.slice(3);

    let payload;
    try {
      payload = parseJsonBytes(base64UrlToBytes(encoded));
    } catch {
      throw new Error("داده لینک قابل خواندن نیست.");
    }
    return validateTripPayload(payload);
  }

  function clearTrip() {
    closeSheet(false);
    if (hotelMarker) {
      hotelMarker.remove();
      hotelMarker = null;
    }
    for (const { marker } of placeMarkers.values()) {
      marker.remove();
    }
    if (currentLocationMarker) {
      currentLocationMarker.remove();
      currentLocationMarker = null;
    }
    selectedMarkerElement?.classList.remove("is-selected");
    selectedMarkerElement = null;
    placeMarkers = new Map();
    tripData = null;
    activeFilter = "all";
    activeView = "map";
    dayDefinitions = [];
    assignments = new Map();
    selectedDayKey = null;
    clusters = [];
    elements.filterButtons.forEach((button) => {
      const isAll = button.dataset.filter === "all";
      button.classList.toggle("is-active", isAll);
      button.setAttribute("aria-pressed", String(isAll));
    });
    elements.viewButtons.forEach((button) => {
      const isMap = button.dataset.view === "map";
      button.classList.toggle("is-active", isMap);
      button.setAttribute("aria-selected", String(isMap));
    });
    elements.viewTabs.hidden = true;
    document.body.classList.remove("has-day-planning");
    elements.filterBar.hidden = true;
    elements.mapStage.hidden = false;
    elements.daysStage.hidden = true;
    elements.dayMapBanner.hidden = true;
    elements.dayTabs.replaceChildren();
    elements.dayPlaceList.replaceChildren();
    elements.clusterList.replaceChildren();
    elements.clustersSection.hidden = true;
    elements.hotelButton.hidden = true;
    elements.shareButton.hidden = true;
    elements.mapActionStack.hidden = true;
    elements.shareStatus.hidden = true;
    elements.copyLinkButton.classList.remove("has-local-changes");
    elements.tripTitle.textContent = "برنامه‌ریز سفر";
    elements.tripDates.hidden = true;
    elements.tripDates.textContent = "";
    document.title = "نقشه سفر";
    if (map) {
      map.jumpTo({
        center: [DEFAULT_VIEW.lng, DEFAULT_VIEW.lat],
        zoom: DEFAULT_ZOOM,
        bearing: 0,
        pitch: 0,
      });
    }
  }

  function showState(type, detail = "") {
    elements.statePanel.hidden = false;
    if (type === "invalid") {
      elements.stateTitle.textContent = "این لینک سفر معتبر نیست.";
      elements.stateMessage.textContent = detail || "لینک کامل و بدون تغییر را دوباره باز کنید.";
      return;
    }
    if (type === "map-error") {
      elements.stateTitle.textContent = "نقشه آماده نیست.";
      elements.stateMessage.textContent = detail || "اتصال اینترنت و دسترسی به سرویس نقشه را بررسی کنید.";
      return;
    }
    elements.stateTitle.textContent = "هیچ سفری بارگذاری نشده است.";
    elements.stateMessage.textContent = "برای دیدن سفر، لینک کامل اشتراک‌گذاری‌شده را باز کنید.";
  }

  async function loadTrip() {
    const sequence = ++loadSequence;
    clearTrip();
    try {
      const decoded = await decodeFragment();
      if (sequence !== loadSequence) {
        return;
      }
      if (!decoded) {
        showState("empty");
        return;
      }
      tripData = decoded;
      renderTrip();
    } catch (error) {
      if (sequence !== loadSequence) {
        return;
      }
      showState("invalid", error instanceof Error ? error.message : "لینک کامل و بدون تغییر را دوباره باز کنید.");
    }
  }

  function initializePlanning() {
    dayDefinitions = normalizeDays();
    assignments = new Map();
    for (const day of dayDefinitions) {
      for (const placeId of day.placeIds) {
        assignments.set(placeId, day.date);
      }
    }
    selectedDayKey = null;
    clusters = Array.isArray(tripData.clusters) && tripData.clusters.length > 0
      ? tripData.clusters.map((cluster) => ({ ...cluster, placeIds: [...cluster.placeIds] }))
      : deriveClusters();
  }

  function normalizeDays() {
    if (Array.isArray(tripData.days) && tripData.days.length > 0) {
      return tripData.days.map((day) => ({
        date: day.date,
        labelFa: day.labelFa || "",
        placeIds: [...day.placeIds],
      }));
    }

    if (!isIsoDate(tripData.trip.startDate) || !isIsoDate(tripData.trip.endDate)) {
      return [];
    }

    const start = new Date(`${tripData.trip.startDate}T12:00:00Z`);
    const end = new Date(`${tripData.trip.endDate}T12:00:00Z`);
    if (end < start) {
      return [];
    }

    const days = [];
    const cursor = new Date(start);
    while (cursor <= end && days.length < 31) {
      days.push({ date: cursor.toISOString().slice(0, 10), labelFa: "", placeIds: [] });
      cursor.setUTCDate(cursor.getUTCDate() + 1);
    }
    return days;
  }

  function deriveClusters() {
    const adjacency = new Map(tripData.places.map((place) => [place.id, new Set()]));
    for (const place of tripData.places) {
      for (const nearbyId of place.nearbyPlaceIds || []) {
        adjacency.get(place.id).add(nearbyId);
        adjacency.get(nearbyId).add(place.id);
      }
    }

    const visited = new Set();
    const derived = [];
    for (const place of tripData.places) {
      if (visited.has(place.id) || adjacency.get(place.id).size === 0) {
        continue;
      }
      const queue = [place.id];
      const placeIds = [];
      visited.add(place.id);
      while (queue.length > 0) {
        const current = queue.shift();
        placeIds.push(current);
        for (const neighbor of adjacency.get(current)) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push(neighbor);
          }
        }
      }
      if (placeIds.length > 1) {
        const number = (derived.length + 1).toLocaleString("fa-IR");
        derived.push({
          id: `nearby-${derived.length + 1}`,
          nameFa: `گروه نزدیک ${number}`,
          nameOriginal: "",
          placeIds,
          planningHintFa: "این مکان‌ها نزدیک یکدیگر هستند و می‌توانند در یک برنامه قرار بگیرند.",
        });
      }
    }
    return derived;
  }

  function clusterForPlace(placeId) {
    return clusters.find((cluster) => cluster.placeIds.includes(placeId)) || null;
  }

  function clusterToneClass(placeId) {
    const index = clusters.findIndex((cluster) => cluster.placeIds.includes(placeId));
    return index >= 0 ? `cluster-tone-${(index % 4) + 1}` : "";
  }

  function isBookingUrgent(place) {
    return place.bookingRequired === true || hasAnyCategory(place, ["booking-required", "booking required"]);
  }

  function dayForPlace(placeId) {
    return assignments.get(placeId) || null;
  }

  function dayByKey(dayKey) {
    return dayDefinitions.find((day) => day.date === dayKey) || null;
  }

  function dayDisplayName(day) {
    return day?.labelFa || formatDayDate(day?.date) || "روز سفر";
  }

  function renderTrip() {
    elements.statePanel.hidden = true;
    elements.tripTitle.textContent = tripData.trip.title;
    document.title = `${tripData.trip.title} | نقشه سفر`;

    const dateText = formatDateRange(tripData.trip.startDate, tripData.trip.endDate);
    elements.tripDates.textContent = dateText;
    elements.tripDates.hidden = !dateText;

    initializePlanning();

    hotelMarker = createMarker(tripData.hotel, true, 0);

    tripData.places.forEach((place, index) => {
      const marker = createMarker(place, false, index + 1);
      placeMarkers.set(place.id, { marker, place, visible: true });
    });

    elements.viewTabs.hidden = dayDefinitions.length === 0;
    document.body.classList.toggle("has-day-planning", dayDefinitions.length > 0);
    elements.hotelButton.hidden = false;
    elements.shareButton.hidden = false;
    elements.mapActionStack.hidden = false;
    renderDayTabs();
    renderClusters();
    switchView("map");
    fitAllLocations();
    announceResults(tripData.places.length);
  }

  function markerContent(location, isHotel, markerNumber) {
    const markerClass = isHotel ? "hotel-marker" : "trip-marker";
    const markerClasses = [markerClass];
    if (!isHotel) {
      const toneClass = clusterToneClass(location.id);
      if (toneClass) {
        markerClasses.push(toneClass);
      }
      if (isBookingUrgent(location)) {
        markerClasses.push("is-booking-urgent");
      }
    }
    const markerText = isHotel ? "⌂" : markerNumber.toLocaleString("fa-IR");
    const markerVisual = document.createElement("span");
    markerVisual.className = markerClasses.join(" ");
    const iconElement = document.createElement("span");
    iconElement.setAttribute("aria-hidden", "true");
    iconElement.textContent = markerText;
    markerVisual.appendChild(iconElement);

    const callout = document.createElement("span");
    callout.className = "marker-callout";
    const titleRow = document.createElement("span");
    titleRow.className = "marker-callout-title";
    if (isNonEmptyString(location.icon, 12)) {
      appendTextElement(titleRow, "span", "marker-callout-icon", location.icon, { "aria-hidden": "true" });
    }
    appendTextElement(titleRow, "strong", "marker-callout-name", displayName(location));
    callout.appendChild(titleRow);
    if (location.nameOriginal && location.nameOriginal !== displayName(location)) {
      appendTextElement(callout, "span", "marker-callout-original", location.nameOriginal, { dir: "ltr" });
    }
    const summary = markerSummary(location, isHotel);
    appendTextElement(callout, "span", "marker-callout-meta", summary);

    const anchor = document.createElement("button");
    anchor.type = "button";
    const calloutTone = markerClasses.find((className) => className.startsWith("cluster-tone-"));
    anchor.className = [
      "map-marker-anchor",
      `marker-callout-${isHotel || markerNumber % 2 === 0 ? "west" : "east"}`,
      isHotel ? "marker-callout-hotel" : "",
      calloutTone || "",
    ].filter(Boolean).join(" ");
    anchor.title = displayName(location);
    anchor.setAttribute("aria-label", [isHotel ? "هتل" : `مکان ${markerText}`, displayName(location), summary].filter(Boolean).join("، "));
    anchor.appendChild(markerVisual);
    anchor.appendChild(callout);
    return { anchor, markerVisual };
  }

  function createMarker(location, isHotel, markerNumber) {
    const { anchor, markerVisual } = markerContent(location, isHotel, markerNumber);
    const coordinates = [location.longitude, location.latitude];
    const marker = new window.maplibregl.Marker({
      element: anchor,
      anchor: "bottom",
    })
      .setLngLat(coordinates)
      .addTo(map);
    marker.tripElement = markerVisual;
    marker.tripAnchor = anchor;
    marker.tripPreferredCallout = isHotel || markerNumber % 2 === 0 ? "west" : "east";
    const activate = () => {
      selectedMarkerElement?.classList.remove("is-selected");
      selectedMarkerElement = markerVisual;
      selectedMarkerElement.classList.add("is-selected");
      map.easeTo({ center: coordinates, duration: 450 });
      openDetails(location, isHotel);
    };
    anchor.addEventListener("click", (event) => {
      event.stopPropagation();
      activate();
    });
    return marker;
  }

  function markerSummary(location, isHotel) {
    if (isHotel) {
      return "محل اقامت";
    }
    const facts = [];
    const price = displayPrice(location.adultPrice);
    if (price !== undefined && price !== null && price !== "") {
      facts.push(Number.isFinite(price) ? price.toLocaleString("fa-IR") : String(price));
    }
    if (location.duration) {
      facts.push(String(location.duration));
    }
    if (facts.length < 2 && location.minimumAge !== undefined && location.minimumAge !== null) {
      facts.push(`حداقل ${location.minimumAge.toLocaleString("fa-IR")} سال`);
    }
    if (facts.length < 2 && location.bookingRequired === true) {
      facts.push("رزرو لازم");
    }
    return facts.slice(0, 2).join(" · ") || "برای دیدن جزئیات لمس کنید";
  }

  function updateMarkerCalloutSides() {
    if (!map) {
      return;
    }
    const markers = [hotelMarker, ...Array.from(placeMarkers.values(), ({ marker }) => marker)].filter(Boolean);
    const mapWidth = map.getContainer().clientWidth;
    const edgeThreshold = Math.min(180, mapWidth * 0.32);
    for (const marker of markers) {
      const anchor = marker.tripAnchor;
      if (!anchor) {
        continue;
      }
      const screenX = map.project(marker.getLngLat()).x;
      const side = screenX < edgeThreshold
        ? "east"
        : screenX > mapWidth - edgeThreshold
          ? "west"
          : marker.tripPreferredCallout;
      anchor.classList.toggle("marker-callout-east", side === "east");
      anchor.classList.toggle("marker-callout-west", side === "west");
    }
  }

  function displayName(location) {
    return location.nameFa || location.nameOriginal || "مکان";
  }

  function categoryList(place) {
    const categories = Array.isArray(place.categories) ? [...place.categories] : [];
    if (isNonEmptyString(place.category, 80)) {
      categories.push(place.category);
    }
    return categories.map((category) => category.toLowerCase().trim());
  }

  function hasAnyCategory(place, targets) {
    const categories = categoryList(place);
    return targets.some((target) => categories.includes(target));
  }

  function isNearHotel(place) {
    if (!tripData?.hotel) {
      return false;
    }
    const configuredRadius = tripData.trip.nearHotelRadiusKm;
    const radius = Number.isFinite(configuredRadius) && configuredRadius > 0 && configuredRadius <= 50
      ? configuredRadius
      : DEFAULT_NEAR_HOTEL_RADIUS_KM;
    return distanceInKm(place, tripData.hotel) <= radius;
  }

  function distanceInKm(first, second) {
    const earthRadius = 6_371;
    const toRadians = (degrees) => degrees * (Math.PI / 180);
    const latitudeDelta = toRadians(second.latitude - first.latitude);
    const longitudeDelta = toRadians(second.longitude - first.longitude);
    const firstLatitude = toRadians(first.latitude);
    const secondLatitude = toRadians(second.latitude);
    const haversine = Math.sin(latitudeDelta / 2) ** 2
      + Math.cos(firstLatitude) * Math.cos(secondLatitude) * Math.sin(longitudeDelta / 2) ** 2;
    return 2 * earthRadius * Math.asin(Math.sqrt(haversine));
  }

  function switchView(viewName) {
    if (!tripData || (viewName === "days" && dayDefinitions.length === 0)) {
      return;
    }
    activeView = viewName;
    elements.viewButtons.forEach((button) => {
      const isActive = button.dataset.view === viewName;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-selected", String(isActive));
    });
    elements.mapStage.hidden = viewName !== "map";
    elements.daysStage.hidden = viewName !== "days";
    elements.filterBar.hidden = viewName !== "map" || tripData.places.length === 0;

    if (viewName === "days") {
      if (!selectedDayKey && dayDefinitions.length > 0) {
        selectedDayKey = dayDefinitions[0].date;
      }
      renderDayTabs();
      renderDayPlanner();
      renderClusters();
      return;
    }

    updateDayMapBanner();
    applyMarkerVisibility();
    window.setTimeout(() => {
      map.resize();
      fitAllLocations();
    }, 0);
  }

  function selectDay(dayKey) {
    if (!dayByKey(dayKey)) {
      return;
    }
    selectedDayKey = dayKey;
    renderDayTabs();
    renderDayPlanner();
    updateDayMapBanner();
    applyMarkerVisibility();
  }

  function clearSelectedDay() {
    selectedDayKey = null;
    renderDayTabs();
    updateDayMapBanner();
    applyMarkerVisibility();
    fitAllLocations();
  }

  function renderDayTabs() {
    elements.dayTabs.replaceChildren();
    for (const day of dayDefinitions) {
      const button = document.createElement("button");
      button.className = `day-tab${selectedDayKey === day.date ? " is-active" : ""}`;
      button.type = "button";
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(selectedDayKey === day.date));
      appendTextElement(button, "span", "", dayDisplayName(day));
      const count = Array.from(assignments.values()).filter((date) => date === day.date).length;
      appendTextElement(button, "small", "", `${count.toLocaleString("fa-IR")} مکان`);
      button.addEventListener("click", () => selectDay(day.date));
      elements.dayTabs.appendChild(button);
    }
  }

  function renderDayPlanner() {
    if (dayDefinitions.length === 0) {
      return;
    }
    if (!selectedDayKey) {
      selectedDayKey = dayDefinitions[0].date;
    }
    const selectedDay = dayByKey(selectedDayKey);
    const assignedCount = tripData.places.filter((place) => dayForPlace(place.id) === selectedDayKey).length;
    elements.dayPlanTitle.textContent = dayDisplayName(selectedDay);
    elements.dayPlaceCount.textContent = `${assignedCount.toLocaleString("fa-IR")} مکان`;
    elements.dayPlaceList.replaceChildren();

    const sortedPlaces = [...tripData.places].sort((first, second) => {
      const rank = (place) => {
        const assignedDay = dayForPlace(place.id);
        if (assignedDay === selectedDayKey) return 0;
        if (!assignedDay) return 1;
        return 2;
      };
      return rank(first) - rank(second);
    });

    if (sortedPlaces.length === 0) {
      appendTextElement(elements.dayPlaceList, "p", "plan-empty", "هنوز مکانی برای برنامه‌ریزی وجود ندارد.");
      return;
    }

    for (const place of sortedPlaces) {
      elements.dayPlaceList.appendChild(createPlanningCard(place));
    }
  }

  function createPlanningCard(place) {
    const assignedDayKey = dayForPlace(place.id);
    const card = document.createElement("article");
    card.className = "planning-card";
    if (assignedDayKey === selectedDayKey) {
      card.classList.add("is-selected-day");
    } else if (assignedDayKey) {
      card.classList.add("is-other-day");
    }

    const copy = document.createElement("div");
    appendTextElement(copy, "h3", "", displayName(place));
    appendTextElement(copy, "p", "original-name", place.nameOriginal, { dir: "ltr" });
    const meta = document.createElement("div");
    meta.className = "planning-meta";
    const cluster = clusterForPlace(place.id);
    if (cluster) {
      appendTextElement(meta, "span", "cluster-badge", cluster.nameFa || cluster.nameOriginal);
    }
    if (isBookingUrgent(place)) {
      appendTextElement(meta, "span", "booking-badge", "رزرو لازم");
    } else if (place.bookingUrgency) {
      appendTextElement(meta, "span", "booking-badge", "رزرو پیشنهادی");
    }
    if (meta.childElementCount > 0) {
      copy.appendChild(meta);
    }
    card.appendChild(copy);

    const control = document.createElement("div");
    control.className = "assignment-control";
    const controlId = `assignment-${tripData.places.findIndex((item) => item.id === place.id)}`;
    appendTextElement(control, "label", "", "روز برنامه", { for: controlId });
    const select = document.createElement("select");
    select.id = controlId;
    select.setAttribute("aria-label", `روز برنامه برای ${displayName(place)}`);
    const emptyOption = document.createElement("option");
    emptyOption.value = "";
    emptyOption.textContent = "بدون روز";
    select.appendChild(emptyOption);
    for (const day of dayDefinitions) {
      const option = document.createElement("option");
      option.value = day.date;
      option.textContent = dayDisplayName(day);
      select.appendChild(option);
    }
    select.value = assignedDayKey || "";
    select.addEventListener("change", () => updateAssignment(place.id, select.value));
    control.appendChild(select);
    card.appendChild(control);

    const mapButton = document.createElement("button");
    mapButton.className = "planning-map-button";
    mapButton.type = "button";
    mapButton.textContent = "نمایش مکان روی نقشه";
    mapButton.addEventListener("click", () => showPlaceOnMap(place));
    card.appendChild(mapButton);
    return card;
  }

  function updateAssignment(placeId, dayKey) {
    if (dayKey && dayByKey(dayKey)) {
      assignments.set(placeId, dayKey);
    } else {
      assignments.delete(placeId);
    }
    elements.copyLinkButton.classList.add("has-local-changes");
    renderDayTabs();
    renderDayPlanner();
    updateDayMapBanner();
    applyMarkerVisibility();
  }

  function showPlaceOnMap(place) {
    selectedDayKey = dayForPlace(place.id);
    switchView("map");
    map.flyTo({
      center: [place.longitude, place.latitude],
      zoom: 15,
      essential: true,
    });
    selectedMarkerElement?.classList.remove("is-selected");
    selectedMarkerElement = placeMarkers.get(place.id)?.marker.tripElement || null;
    selectedMarkerElement?.classList.add("is-selected");
    openDetails(place, false);
  }

  function updateDayMapBanner() {
    const day = dayByKey(selectedDayKey);
    elements.dayMapBanner.hidden = activeView !== "map" || !day;
    elements.dayMapTitle.textContent = day ? dayDisplayName(day) : "";
  }

  function renderClusters() {
    elements.clusterList.replaceChildren();
    elements.clustersSection.hidden = clusters.length === 0;
    for (const cluster of clusters) {
      const card = document.createElement("article");
      card.className = "cluster-card";
      appendTextElement(card, "h3", "", cluster.nameFa || cluster.nameOriginal);
      appendTextElement(card, "p", "original-name", cluster.nameOriginal, { dir: "ltr" });
      const placeNames = cluster.placeIds
        .map((id) => tripData.places.find((place) => place.id === id))
        .filter(Boolean)
        .map(displayName)
        .join("، ");
      appendTextElement(card, "p", "cluster-places", placeNames);
      appendTextElement(card, "p", "", cluster.planningHintFa);
      elements.clusterList.appendChild(card);
    }
  }

  function applyMarkerVisibility() {
    if (!tripData) {
      return;
    }
    let visibleCount = 0;
    for (const markerRecord of placeMarkers.values()) {
      const { marker, place } = markerRecord;
      const matchesCategory = filterTests[activeFilter](place);
      const matchesDay = !selectedDayKey || dayForPlace(place.id) === selectedDayKey;
      const isVisible = matchesCategory && matchesDay;
      if (isVisible && !markerRecord.visible) {
        marker.addTo(map);
      } else if (!isVisible && markerRecord.visible) {
        marker.remove();
      }
      markerRecord.visible = isVisible;
      if (isVisible) {
        visibleCount += 1;
      }
    }
    announceResults(visibleCount);
  }

  function setFilter(filterName) {
    if (!tripData || !filterTests[filterName]) {
      return;
    }
    activeFilter = filterName;
    elements.filterButtons.forEach((button) => {
      const isActive = button.dataset.filter === filterName;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", String(isActive));
    });

    applyMarkerVisibility();
  }

  function announceResults(count) {
    elements.resultStatus.textContent = `${count.toLocaleString("fa-IR")} مکان نمایش داده می‌شود.`;
  }

  function fitAllLocations() {
    if (!tripData) {
      return;
    }
    const points = [
      [tripData.hotel.longitude, tripData.hotel.latitude],
      ...Array.from(placeMarkers.values())
        .filter(({ visible }) => visible)
        .map(({ place }) => [place.longitude, place.latitude]),
    ];
    if (points.length === 1) {
      map.easeTo({ center: points[0], zoom: 14, duration: 500 });
      return;
    }
    const bounds = new window.maplibregl.LngLatBounds();
    points.forEach((point) => bounds.extend(point));
    map.fitBounds(bounds, {
      padding: 56,
      maxZoom: 14,
      duration: 650,
    });
  }

  function recenterHotel() {
    if (!tripData) {
      return;
    }
    map.flyTo({
      center: [tripData.hotel.longitude, tripData.hotel.latitude],
      zoom: 15,
      essential: true,
    });
    selectedMarkerElement?.classList.remove("is-selected");
    selectedMarkerElement = hotelMarker.tripElement;
    selectedMarkerElement?.classList.add("is-selected");
  }

  function showShareStatus(message, isError = false) {
    window.clearTimeout(shareStatusTimer);
    elements.shareStatus.textContent = message;
    elements.shareStatus.hidden = false;
    elements.shareStatus.classList.toggle("is-error", isError);
    shareStatusTimer = window.setTimeout(() => {
      elements.shareStatus.hidden = true;
    }, 4_000);
  }

  function showCurrentLocation() {
    if (!tripData || !map) {
      return;
    }
    if (!navigator.geolocation) {
      showShareStatus("این مرورگر موقعیت مکانی را پشتیبانی نمی‌کند.", true);
      return;
    }

    elements.locationButton.disabled = true;
    navigator.geolocation.getCurrentPosition((position) => {
      const location = [position.coords.longitude, position.coords.latitude];
      if (currentLocationMarker) {
        currentLocationMarker.remove();
      }
      const content = document.createElement("span");
      content.className = "current-location-marker";
      content.setAttribute("aria-label", "موقعیت فعلی من");
      currentLocationMarker = new window.maplibregl.Marker({
        element: content,
        anchor: "center",
      })
        .setLngLat(location)
        .addTo(map);
      map.flyTo({
        center: location,
        zoom: Math.max(map.getZoom(), 15),
        essential: true,
      });
      elements.locationButton.disabled = false;
      showShareStatus("موقعیت فعلی روی نقشه نمایش داده شد.");
    }, (error) => {
      elements.locationButton.disabled = false;
      const message = error.code === error.PERMISSION_DENIED
        ? "اجازه دسترسی به موقعیت داده نشد."
        : "موقعیت فعلی پیدا نشد.";
      showShareStatus(message, true);
    }, {
      enableHighAccuracy: true,
      timeout: 12_000,
      maximumAge: 60_000,
    });
  }

  function tripStateForSharing() {
    const payload = JSON.parse(JSON.stringify(tripData));
    if (dayDefinitions.length > 0) {
      payload.days = dayDefinitions.map((day) => ({
        date: day.date,
        ...(day.labelFa ? { labelFa: day.labelFa } : {}),
        placeIds: tripData.places
          .filter((place) => dayForPlace(place.id) === day.date)
          .map((place) => place.id),
      }));
    }
    return validateTripPayload(payload);
  }

  async function prepareBytesForSharing(jsonBytes) {
    if (!("CompressionStream" in window)) {
      return { compressionMode: "n", bytes: jsonBytes };
    }
    const compressedStream = new Blob([jsonBytes])
      .stream()
      .pipeThrough(new CompressionStream("gzip"));
    const compressed = await readStreamWithLimit(compressedStream, MAX_FRAGMENT_LENGTH);
    return { compressionMode: "g", bytes: compressed };
  }

  async function createUpdatedShareUrl() {
    if (!tripData || !window.crypto?.subtle) {
      throw new Error("این مرورگر امکان ساخت لینک امن را ندارد.");
    }

    const payload = tripStateForSharing();
    const jsonBytes = new TextEncoder().encode(JSON.stringify(payload));
    const prepared = await prepareBytesForSharing(jsonBytes);
    const keyBytes = window.crypto.getRandomValues(new Uint8Array(32));
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const key = await window.crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
    const ciphertext = new Uint8Array(await window.crypto.subtle.encrypt({
      name: "AES-GCM",
      iv,
      additionalData: new TextEncoder().encode(`${SHARE_ADDITIONAL_DATA_PREFIX}:${prepared.compressionMode}`),
    }, key, prepared.bytes));

    const fragment = [
      SHARE_FORMAT_VERSION,
      prepared.compressionMode,
      bytesToBase64Url(keyBytes),
      bytesToBase64Url(iv),
      bytesToBase64Url(ciphertext),
    ].join(".");
    if (fragment.length > MAX_FRAGMENT_LENGTH) {
      throw new Error("اطلاعات سفر برای یک لینک بیش از حد بزرگ است.");
    }

    const url = new URL(window.location.href);
    url.hash = fragment;
    window.history.replaceState(null, "", url);
    elements.copyLinkButton.classList.remove("has-local-changes");
    return url.href;
  }

  async function copyText(value) {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(value);
      return;
    }
    const input = document.createElement("textarea");
    input.value = value;
    input.setAttribute("readonly", "");
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    const copied = document.execCommand("copy");
    input.remove();
    if (!copied) {
      throw new Error("کپی لینک انجام نشد.");
    }
  }

  function setShareButtonsBusy(isBusy) {
    elements.shareButton.disabled = isBusy;
    elements.copyLinkButton.disabled = isBusy;
  }

  async function copyUpdatedLink() {
    setShareButtonsBusy(true);
    try {
      const url = await createUpdatedShareUrl();
      await copyText(url);
      showShareStatus("لینک تازه و رمزگذاری‌شده کپی شد.");
    } catch (error) {
      showShareStatus(error instanceof Error ? error.message : "ساخت لینک انجام نشد.", true);
    } finally {
      setShareButtonsBusy(false);
    }
  }

  async function shareTrip() {
    setShareButtonsBusy(true);
    try {
      const url = await createUpdatedShareUrl();
      if (navigator.share) {
        await navigator.share({
          title: tripData.trip.title,
          text: "لینک خصوصی برنامه سفر",
          url,
        });
        showShareStatus("لینک سفر برای اشتراک آماده شد.");
      } else {
        await copyText(url);
        showShareStatus("اشتراک مستقیم در دسترس نبود؛ لینک کپی شد.");
      }
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        showShareStatus(error instanceof Error ? error.message : "اشتراک لینک انجام نشد.", true);
      }
    } finally {
      setShareButtonsBusy(false);
    }
  }

  function formatDayDate(value) {
    if (!isIsoDate(value)) {
      return "";
    }
    return new Intl.DateTimeFormat("fa-IR-u-ca-gregory", {
      weekday: "long",
      month: "short",
      day: "numeric",
      timeZone: "UTC",
    }).format(new Date(`${value}T12:00:00Z`));
  }

  function formatDateRange(startDate, endDate) {
    const formatOne = (value) => {
      if (!isNonEmptyString(value, 32) || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return "";
      }
      const date = new Date(`${value}T12:00:00Z`);
      if (Number.isNaN(date.getTime())) {
        return "";
      }
      return new Intl.DateTimeFormat("fa-IR-u-ca-gregory", {
        year: "numeric",
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }).format(date);
    };
    const start = formatOne(startDate);
    const end = formatOne(endDate);
    return start && end ? `${start} تا ${end}` : start || end;
  }

  function appendTextElement(parent, tagName, className, text, attributes = {}) {
    if (text === undefined || text === null || text === "") {
      return null;
    }
    const element = document.createElement(tagName);
    element.className = className;
    element.textContent = String(text);
    for (const [name, value] of Object.entries(attributes)) {
      element.setAttribute(name, value);
    }
    parent.appendChild(element);
    return element;
  }

  function addFact(container, label, value) {
    if (value === undefined || value === null || value === "") {
      return;
    }
    const item = document.createElement("div");
    item.className = "fact-item";
    appendTextElement(item, "span", "fact-label", label);
    appendTextElement(item, "strong", "fact-value", value);
    container.appendChild(item);
  }

  function displayPrice(value) {
    return value === 0 || value === "0" ? "رایگان" : value;
  }

  function safeExternalUrl(value) {
    if (!isNonEmptyString(value, 2_000)) {
      return null;
    }
    try {
      const url = new URL(value);
      return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
    } catch {
      return null;
    }
  }

  function addAction(container, label, href, isPrimary = false) {
    if (!href) {
      return;
    }
    const link = document.createElement("a");
    link.className = `detail-link${isPrimary ? " is-primary" : ""}`;
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.referrerPolicy = "no-referrer";
    link.textContent = label;
    container.appendChild(link);
  }

  function openDetails(location, isHotel) {
    lastFocusedElement = document.activeElement;
    elements.detailContent.replaceChildren();

    const detailKicker = isHotel
      ? "محل اقامت"
      : isBookingUrgent(location)
        ? "رزرو مهم · مکان پیشنهادی"
        : "مکان پیشنهادی";
    appendTextElement(elements.detailContent, "p", "detail-kicker", detailKicker);
    appendTextElement(elements.detailContent, "h2", "", location.nameFa || location.nameOriginal, { id: "detail-title" });
    appendTextElement(elements.detailContent, "p", "original-name", location.nameOriginal, { dir: "ltr" });
    appendTextElement(elements.detailContent, "p", "detail-description", location.descriptionFa);

    const factGrid = document.createElement("div");
    factGrid.className = "fact-grid";
    if (!isHotel) {
      addFact(factGrid, "قیمت بزرگسال", displayPrice(location.adultPrice));
      addFact(factGrid, "قیمت کودک", displayPrice(location.childPrice));
      addFact(factGrid, "مدت پیشنهادی", location.duration);
      if (location.minimumAge !== undefined && location.minimumAge !== null) {
        addFact(factGrid, "محدودیت سنی", `حداقل ${location.minimumAge.toLocaleString("fa-IR")} سال`);
      } else if (location.childFriendly !== undefined) {
        addFact(factGrid, "مناسب کودک", location.childFriendly ? "بله" : "خیر");
      }
      if (location.bookingRequired === true) {
        addFact(factGrid, "رزرو", "لازم است");
      }
      addFact(factGrid, "وضعیت رزرو", location.bookingUrgency);
      const assignedDay = dayByKey(dayForPlace(location.id));
      addFact(factGrid, "روز برنامه", assignedDay ? dayDisplayName(assignedDay) : "بدون روز");
    }
    if (factGrid.childElementCount > 0) {
      elements.detailContent.appendChild(factGrid);
    }

    const cluster = !isHotel ? clusterForPlace(location.id) : null;
    if (cluster) {
      const nearbyNames = cluster.placeIds
        .filter((id) => id !== location.id)
        .map((id) => tripData.places.find((place) => place.id === id))
        .filter(Boolean)
        .map(displayName)
        .join("، ");
      const clusterText = nearbyNames
        ? `${cluster.nameFa || cluster.nameOriginal}: ${nearbyNames}`
        : cluster.nameFa || cluster.nameOriginal;
      appendTextElement(elements.detailContent, "p", "detail-note", clusterText);
    }
    appendTextElement(elements.detailContent, "p", "detail-note", location.planningNotes);

    const actions = document.createElement("div");
    actions.className = "detail-actions";
    const navigationUrl = new URL("https://www.google.com/maps/dir/");
    navigationUrl.searchParams.set("api", "1");
    navigationUrl.searchParams.set("destination", `${location.latitude},${location.longitude}`);
    navigationUrl.searchParams.set("travelmode", "walking");
    addAction(actions, "نمایش مسیر پیاده در Google Maps", navigationUrl.toString(), true);
    addAction(actions, "وب‌سایت رسمی", safeExternalUrl(location.officialUrl));
    addAction(actions, "خرید بلیط", safeExternalUrl(location.ticketUrl));
    elements.detailContent.appendChild(actions);

    elements.sheet.hidden = false;
    elements.sheetBackdrop.hidden = false;
    elements.sheet.setAttribute("aria-hidden", "false");
    elements.sheetClose.focus();
  }

  function closeSheet(restoreFocus = true) {
    if (elements.sheet.hidden) {
      return;
    }
    elements.sheet.hidden = true;
    elements.sheetBackdrop.hidden = true;
    elements.sheet.setAttribute("aria-hidden", "true");
    if (restoreFocus && lastFocusedElement instanceof HTMLElement) {
      lastFocusedElement.focus();
    }
  }

  elements.viewButtons.forEach((button) => {
    button.addEventListener("click", () => switchView(button.dataset.view));
  });
  elements.filterButtons.forEach((button) => {
    button.addEventListener("click", () => setFilter(button.dataset.filter));
  });
  elements.hotelButton.addEventListener("click", recenterHotel);
  elements.fitButton.addEventListener("click", fitAllLocations);
  elements.locationButton.addEventListener("click", showCurrentLocation);
  elements.shareButton.addEventListener("click", shareTrip);
  elements.copyLinkButton.addEventListener("click", copyUpdatedLink);
  elements.clearDayButton.addEventListener("click", clearSelectedDay);
  elements.showDayMapButton.addEventListener("click", () => switchView("map"));
  elements.sheetClose.addEventListener("click", () => closeSheet());
  elements.sheetBackdrop.addEventListener("click", () => closeSheet());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeSheet();
    }
  });
  window.addEventListener("hashchange", () => {
    if (map) {
      loadTrip();
      return;
    }
    clearTrip();
    showState("map-error", mapInitializationError);
  });

  async function start() {
    try {
      await initializeMap();
      await loadTrip();
    } catch (error) {
      mapInitializationError = error instanceof Error ? error.message : mapInitializationError;
      if (map) {
        map.remove();
        map = null;
      }
      clearTrip();
      showState("map-error", mapInitializationError);
    }
  }

  start();
})();
