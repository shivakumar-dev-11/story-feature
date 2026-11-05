const STORAGE_KEY = "stories:v1";
const EXPIRY_MS = 24 * 60 * 60 * 1000;
const MAX_WIDTH = 1080;
const MAX_HEIGHT = 1920;
const STORY_DURATION_MS = 15000;
const SWIPE_THRESHOLD = 50;

let viewerStack = [];
let viewerIndex = 0;
let timerId = null;
let timerStartedAt = 0;
let touchStartX = 0;
let touchStartY = 0;
let didSwipe = false;

/** Read all stories from localStorage and return a safe array. */
const loadStories = () => {
  const data = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
  return Array.isArray(data) ? data : [];
};

/** Persist the full stories array to localStorage. */
const saveStories = (stories) => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(stories));
};

/** Build one story record from a cropped base64 image. */
const createStory = (base64) => ({
  id: Date.now(),
  base64,
  createdAt: Date.now(),
  seen: false,
});

/** Prepend a new story so the newest appears first in the tray. */
const addStory = (story) => {
  const stories = [story].concat(loadStories());
  saveStories(stories);
  return stories;
};

/** Mark a single story as seen and save; returns updated list. */
const markStorySeen = (id) => {
  const stories = loadStories().map((story) => {
    if (story.id === id) {
      return {
        id: story.id,
        base64: story.base64,
        createdAt: story.createdAt,
        seen: true,
      };
    }
    return story;
  });
  saveStories(stories);
  return stories;
};

/** Drop stories older than 24 hours and save the rest. */
const removeExpiredStories = () => {
  const now = Date.now();
  const active = loadStories().filter(
    (story) => now - story.createdAt < EXPIRY_MS
  );
  saveStories(active);
  return active;
};

/** Show an upload error message under the tray. */
const showUploadError = (message) => {
  const el = document.getElementById("upload-error");
  el.textContent = message;
  el.hidden = false;
};

/** Hide the upload error banner. */
const hideUploadError = () => {
  document.getElementById("upload-error").hidden = true;
};

/** Read a File object as a data URL (base64) for canvas processing. */
const readFileAsDataURL = (file) =>
  new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });

/**
 * Center-crop to 9:16, then scale down to fit inside 1080×1920.
 * Returns a JPEG data URL ready to store.
 */
const cropImage = (src) =>
  new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const targetRatio = 9 / 16;
      let sourceWidth = img.width;
      let sourceHeight = img.height;
      let sourceX = 0;
      let sourceY = 0;

      const imageRatio = sourceWidth / sourceHeight;

      if (imageRatio > targetRatio) {
        sourceWidth = sourceHeight * targetRatio;
        sourceX = (img.width - sourceWidth) / 2;
      } else if (imageRatio < targetRatio) {
        sourceHeight = sourceWidth / targetRatio;
        sourceY = (img.height - sourceHeight) / 2;
      }

      let outWidth = sourceWidth;
      let outHeight = sourceHeight;

      if (outWidth > MAX_WIDTH || outHeight > MAX_HEIGHT) {
        const scale = Math.min(MAX_WIDTH / outWidth, MAX_HEIGHT / outHeight);
        outWidth = Math.floor(outWidth * scale);
        outHeight = Math.floor(outHeight * scale);
      } else {
        outWidth = Math.floor(outWidth);
        outHeight = Math.floor(outHeight);
      }

      const canvas = document.createElement("canvas");
      canvas.width = outWidth;
      canvas.height = outHeight;

      const ctx = canvas.getContext("2d");
      ctx.drawImage(
        img,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        0,
        0,
        outWidth,
        outHeight
      );

      resolve(canvas.toDataURL("image/jpeg", 0.92));
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });

/** Create one tray item: circular ring button + label (ring must stay square). */
const createStoryCircle = (story) => {
  const item = document.createElement("div");
  item.className = "tray__item story-circle";

  const button = document.createElement("button");
  button.type = "button";
  button.className =
    "story-ring story-ring--story " +
    (story.seen ? "ring-seen" : "ring-unseen");
  button.dataset.storyId = String(story.id);
  button.setAttribute("aria-label", "View story");

  const inner = document.createElement("span");
  inner.className = "story-ring__inner";

  const img = document.createElement("img");
  img.className = "story-ring__thumb";
  img.src = story.base64;
  img.alt = "";

  inner.appendChild(img);
  button.appendChild(inner);
  item.appendChild(button);

  const label = document.createElement("span");
  label.className = "tray__label";
  label.textContent = "Your story";
  item.appendChild(label);

  return item;
};

/** Rebuild the tray: remove old rings and render one per saved story. */
const renderTray = (stories) => {
  const tray = document.getElementById("story-tray");
  Array.from(tray.querySelectorAll(".story-circle")).forEach((item) =>
    item.remove()
  );
  stories.forEach((story) => tray.appendChild(createStoryCircle(story)));

  document.getElementById("hint-empty").hidden = stories.length > 0;
};

/** Validate, crop, save, and refresh UI after the user picks a file. */
const processUpload = async (file) => {
  hideUploadError();
  if (!file || !file.type.startsWith("image/")) return;

  const base64 = await readFileAsDataURL(file);
  if (!base64) return;

  const cropped = await cropImage(base64);
  if (!cropped) {
    showUploadError("Could not process this image. Try another file.");
    return;
  }

  addStory(createStory(cropped));
  renderTray(loadStories());
};

/** Handle file input change: upload one image and reset the input. */
const handleFileSelect = (event) => {
  const file = event.target.files[0];
  processUpload(file);
  event.target.value = "";
};

/** Build the playback queue from the clicked story through the newest. */
const getStackFrom = (startId) => {
  const stories = loadStories();
  const startIndex = stories.findIndex(
    (story) => story.id === Number(startId)
  );
  if (startIndex === -1) return [];
  return stories.slice(startIndex);
};

/** Clear the progress interval timer if it is running. */
const stopTimer = () => {
  if (timerId !== null) {
    clearInterval(timerId);
    timerId = null;
  }
};

/** Set the active segment fill width from elapsed time (0–100%). */
const updateActiveProgress = () => {
  const active = document.querySelector(
    "#progress-segments .progress-segment.is-active .progress-segment__fill"
  );
  if (!active) return;

  const elapsed = Date.now() - timerStartedAt;
  let percent = (elapsed / STORY_DURATION_MS) * 100;
  if (percent > 100) percent = 100;
  active.style.width = percent + "%";
};

/** Draw one progress segment per story in the current viewer stack. */
const renderProgressSegments = () => {
  const container = document.getElementById("progress-segments");
  container.innerHTML = "";

  viewerStack.forEach((story, index) => {
    const segment = document.createElement("div");
    segment.className = "progress-segment";

    if (index < viewerIndex) {
      segment.className = "progress-segment is-complete";
    } else if (index === viewerIndex) {
      segment.className = "progress-segment is-active";
    }

    const fill = document.createElement("span");
    fill.className = "progress-segment__fill";
    if (index < viewerIndex) {
      fill.style.width = "100%";
    } else if (index === viewerIndex) {
      fill.style.width = "0%";
    }
    segment.appendChild(fill);
    container.appendChild(segment);
  });
};

/** Start (or restart) the 15s timer and update the active bar every 50ms. */
const startTimer = () => {
  stopTimer();
  timerStartedAt = Date.now();
  updateActiveProgress();

  timerId = setInterval(() => {
    updateActiveProgress();
    const elapsed = Date.now() - timerStartedAt;
    if (elapsed >= STORY_DURATION_MS) {
      goNext();
    }
  }, 50);
};

/** Show story at index: image, seen state, progress bars, and timer. */
const showStoryAt = (index) => {
  viewerIndex = index;
  const story = viewerStack[viewerIndex];
  if (!story) {
    closeViewer();
    return;
  }

  document.getElementById("viewer-image").src = story.base64;
  markStorySeen(story.id);
  renderTray(loadStories());
  renderProgressSegments();
  startTimer();
};

/** Advance to the next story or close when the last one finishes. */
const goNext = () => {
  if (viewerIndex >= viewerStack.length - 1) {
    closeViewer();
    return;
  }
  showStoryAt(viewerIndex + 1);
};

/** Go to the previous story in the stack (no-op on the first). */
const goPrev = () => {
  if (viewerIndex <= 0) return;
  showStoryAt(viewerIndex - 1);
};

/** Open fullscreen viewer starting at the story the user tapped. */
const openViewer = (startId) => {
  viewerStack = getStackFrom(startId);
  if (viewerStack.length === 0) return;

  viewerIndex = 0;
  document.getElementById("viewer").hidden = false;
  document.body.classList.add("viewer-open");
  showStoryAt(0);
};

/** Stop playback, hide viewer, and reset viewer state. */
const closeViewer = () => {
  stopTimer();
  viewerStack = [];
  viewerIndex = 0;
  document.getElementById("viewer").hidden = true;
  document.getElementById("viewer-image").removeAttribute("src");
  document.body.classList.remove("viewer-open");
};

/** Delegate tray clicks: open viewer from the tapped story ring. */
const handleTrayClick = (event) => {
  const button = event.target.closest(".story-ring--story");
  if (!button) return;
  openViewer(button.dataset.storyId);
};

/** Tap left/right half of the frame to go prev/next (skip if user swiped). */
const handleFrameClick = (event) => {
  if (document.getElementById("viewer").hidden) return;
  if (event.target.closest("#viewer-close")) return;

  if (didSwipe) {
    didSwipe = false;
    return;
  }

  const frame = document.getElementById("viewer-frame");
  const rect = frame.getBoundingClientRect();
  const x = event.clientX - rect.left;

  if (x < rect.width / 2) {
    goPrev();
  } else {
    goNext();
  }
};

/** Remember touch start position for swipe detection. */
const handleTouchStart = (event) => {
  touchStartX = event.changedTouches[0].screenX;
  touchStartY = event.changedTouches[0].screenY;
};

/** Swipe horizontally to go next (left) or previous (right). */
const handleTouchEnd = (event) => {
  const dx = event.changedTouches[0].screenX - touchStartX;
  const dy = event.changedTouches[0].screenY - touchStartY;

  if (Math.abs(dx) < SWIPE_THRESHOLD) return;
  if (Math.abs(dx) <= Math.abs(dy)) return;

  didSwipe = true;
  if (dx < 0) {
    goNext();
  } else {
    goPrev();
  }

  setTimeout(() => {
    didSwipe = false;
  }, 100);
};

/** Close button: stop propagation so the frame click handler does not run. */
const handleCloseClick = (event) => {
  event.stopPropagation();
  closeViewer();
};

/** Close when clicking the backdrop layer itself (not children). */
const handleBackdropClick = (event) => {
  if (event.target !== event.currentTarget) return;
  closeViewer();
};

/** Remove expired stories and refresh tray if anything was deleted. */
const cleanupExpiredStories = () => {
  const beforeCount = loadStories().length;
  const active = removeExpiredStories();
  if (active.length !== beforeCount) {
    renderTray(active);
  }
};

/** Attach swipe and tap handlers on the story frame. */
const bindGestures = () => {
  const frame = document.getElementById("viewer-frame");
  frame.addEventListener("click", handleFrameClick);
  frame.addEventListener("touchstart", handleTouchStart, { passive: true });
  frame.addEventListener("touchend", handleTouchEnd, { passive: true });
};

/** Wire upload, tray, viewer close, backdrop, and gestures. */
const bindEvents = () => {
  document
    .getElementById("btn-add-story")
    .addEventListener("click", () => {
      document.getElementById("file-input").click();
    });
  document
    .getElementById("file-input")
    .addEventListener("change", handleFileSelect);
  document
    .getElementById("story-tray")
    .addEventListener("click", handleTrayClick);
  document
    .getElementById("viewer-close")
    .addEventListener("click", handleCloseClick);
  document
    .getElementById("viewer-backdrop")
    .addEventListener("click", handleBackdropClick);
  bindGestures();

  document.addEventListener("keydown", (event) => {
    if (document.getElementById("viewer").hidden) return;
    if (event.key === "Escape") closeViewer();
    if (event.key === "ArrowRight") goNext();
    if (event.key === "ArrowLeft") goPrev();
  });
};

/** Boot: hide viewer, purge expired, render tray, bind UI, schedule cleanup. */
const init = () => {
  document.getElementById("viewer").hidden = true;
  removeExpiredStories();
  renderTray(loadStories());
  bindEvents();
  setInterval(cleanupExpiredStories, 60000);
};

init();
