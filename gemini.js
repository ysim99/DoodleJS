const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_GENERATION_ATTEMPTS = 3;

async function processAll() {
  if (running) return;

  const apiKey = $('apiKey').value.trim();
  const model = $('model').value;
  const template = $('template').value.trim();

  if (!apiKey) {
    setStatus('Enter a Gemini API key first');
    $('apiKey').focus();
    return;
  }
  if (!template) {
    setStatus('Enter a prompt template first');
    $('template').focus();
    return;
  }
  if (!model) {
    setStatus('Choose a model first');
    $('model').focus();
    return;
  }

  let images = [];
  if (mode === 'csv') {
    images = directImages.slice();
  } else {
    if (urls.length === 0) {
      setStatus('Add at least one page URL first');
      return;
    }

    setStatus('Crawling pages for images...', true);
    for (let i = 0; i < urls.length; i++) {
      const pageUrl = urls[i];
      const imageUrls = await fetchImages(pageUrl);
      const pageTitle = getDisplayTitleFromUrl(pageUrl);
      imageUrls.forEach(src => images.push({ title: pageTitle, src }));
      setProgress(((i + 1) / urls.length) * 20);
    }
  }

  if (images.length === 0) {
    setStatus(mode === 'csv' ? 'Import at least one image CSV row first' : 'No images found on the supplied page URLs');
    return;
  }

  running = true;
  paused = false;
  $('runBtn').disabled = true;
  $('pauseBtn').style.display = '';
  $('pauseBtn').innerHTML = '<i class="ti ti-player-pause"></i> Pause';
  $('progressWrap').style.display = '';
  $('resultsSection').style.display = '';
  $('exportBtn').style.display = 'none';
  $('clearBtn').style.display = 'none';
  setProgress(mode === 'crawl' ? 20 : 0);

  try {
    let skipped = 0;
    for (let i = 0; i < images.length; i++) {
      await waitIfPaused();

      const image = images[i];
      setStatus(`Generating ${i + 1} of ${images.length}...`, true);

      try {
        const alt = await generateAltTextWithRetry({
          apiKey,
          model,
          template,
          title: image.title,
          src: image.src
        });
        results.push({ title: image.title, src: image.src, alt });
        addResultRow(image.title, image.src, alt);
      } catch (err) {
        skipped++;
        console.warn('Gemini generation skipped:', image.src, err);
      }

      const startPct = mode === 'crawl' ? 20 : 0;
      const rangePct = mode === 'crawl' ? 80 : 100;
      setProgress(startPct + ((i + 1) / images.length) * rangePct);
      $('resultsCount').textContent = `${results.length} row${results.length === 1 ? '' : 's'}`;
    }

    setStatus(`Done. Generated ${results.length} alt text result${results.length === 1 ? '' : 's'}${skipped ? `; skipped ${skipped} failed image${skipped === 1 ? '' : 's'}` : ''}.`);
  } finally {
    running = false;
    paused = false;
    $('runBtn').disabled = false;
    $('pauseBtn').style.display = 'none';
    $('exportBtn').style.display = results.length ? '' : 'none';
    $('clearBtn').style.display = results.length ? '' : 'none';
  }
}

async function generateAltTextWithRetry(params) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    try {
      if (attempt > 1) {
        setStatus(`Retrying ${attempt} of ${MAX_GENERATION_ATTEMPTS}...`, true);
      }
      return await generateGeminiAltText(params);
    } catch (err) {
      lastError = err;
      if (attempt < MAX_GENERATION_ATTEMPTS) {
        await delay(600 * attempt);
      }
    }
  }

  throw lastError;
}

async function generateGeminiAltText({ apiKey, model, template, title, src }) {
  const inlineData = await imageUrlToInlineData(src);
  const prompt = buildPrompt(template, title, src);
  const endpoint = `${GEMINI_API_BASE}/${encodeURIComponent(normalizeModelId(model))}:generateContent`;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': apiKey
    },
    body: JSON.stringify({
      contents: [{
        role: 'user',
        parts: [
          { text: prompt },
          { inlineData }
        ]
      }],
      generationConfig: {
        temperature: 0.2,
        maxOutputTokens: 120
      }
    })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error?.message || `Gemini API returned ${res.status}`);
  }

  const text = extractGeminiText(data);
  if (!text) {
    const reason = data.candidates?.[0]?.finishReason;
    throw new Error(reason ? `No text returned (${reason})` : 'No text returned from Gemini');
  }

  return cleanAltText(text, title);
}

async function loadGeminiModels() {
  const apiKey = $('apiKey').value.trim();
  if (!apiKey) {
    setStatus('Enter a Gemini API key before loading models');
    $('apiKey').focus();
    return;
  }

  setStatus('Loading Gemini models...', true);
  try {
    const res = await fetch(GEMINI_API_BASE, {
      headers: { 'x-goog-api-key': apiKey }
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error?.message || `ListModels returned ${res.status}`);
    }

    const models = (data.models || [])
      .filter(model => (model.supportedGenerationMethods || []).includes('generateContent'))
      .map(model => ({
        id: normalizeModelId(model.name),
        label: model.displayName || normalizeModelId(model.name)
      }))
      .sort((a, b) => a.label.localeCompare(b.label));

    if (!models.length) {
      setStatus('No generateContent models were returned for this API key');
      return;
    }

    const select = $('model');
    const previous = select.value;
    select.innerHTML = models.map(model =>
      `<option value="${escapeHtml(model.id)}">${escapeHtml(model.label)} (${escapeHtml(model.id)})</option>`
    ).join('');

    if (models.some(model => model.id === previous)) {
      select.value = previous;
    }

    setStatus(`Loaded ${models.length} Gemini model${models.length === 1 ? '' : 's'} that support generateContent`);
  } catch (err) {
    setStatus(`Could not load models: ${cleanErrorMessage(err)}`);
  }
}

function normalizeModelId(modelName) {
  return String(modelName || '').replace(/^models\//, '');
}

function buildPrompt(template, title, src) {
  const context = [
    title ? `Image title/context: ${title}` : '',
    `Image URL: ${src}`
  ].filter(Boolean).join('\n');

  return `${template}

Hard output rules:
- Return exactly one line of alt text.
- Do not include guidelines, analysis, drafts, character counts, labels, markdown, or explanations.
- Do not repeat the final answer.
- Use this exact format when a title/context is available: {Title} - {Image Description}

${context}`;
}

function cleanAltText(text, title) {
  const raw = String(text || '').replace(/\r/g, '\n').trim();
  let cleaned = extractLastTitledAnswer(raw, title);

  if (!cleaned) {
    cleaned = raw
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => !looksLikeReasoningLine(line))
    .pop() || '';
  }

  cleaned = cleaned
    .replace(/^[-*`"' ]+|[`"' ]+$/g, '')
    .replace(/^alt text\s*only\??\s*/i, '')
    .replace(/^alt text\s*:\s*/i, '')
    .trim();

  const repeated = findRepeatedAnswer(cleaned);
  if (repeated) cleaned = repeated;

  if (title && !cleaned.toLowerCase().startsWith(`${title.toLowerCase()} - `)) {
    cleaned = `${title} - ${cleaned.replace(new RegExp(`^${escapeRegExp(title)}\\s*-\\s*`, 'i'), '')}`;
  }

  return cleaned.trim();
}

function extractLastTitledAnswer(text, title) {
  if (!title) return '';

  const markerPattern = new RegExp(`${escapeRegExp(title)}\\s*-\\s*`, 'gi');
  const matches = [...text.matchAll(markerPattern)];
  if (!matches.length) return '';

  const start = matches[matches.length - 1].index;
  return text.slice(start)
    .replace(/\s+/g, ' ')
    .replace(/\(\d+\s*chars?\).*$/i, '')
    .trim();
}

function looksLikeReasoningLine(line) {
  return /^(guidelines?|title\/context|image|product|color|features?|device|draft\s*\d+|alt text only|specific\/descriptive|under 125|no ["']?image of|format)\s*[:*?-]/i.test(line)
    || /^\*+\s*(guidelines?|draft\s*\d+|alt text only|specific\/descriptive|under 125|format)/i.test(line)
    || /\(\d+\s*chars?\)/i.test(line)
    || /^[-*]\s*(good|strong|a bit tight)\b/i.test(line);
}

function findRepeatedAnswer(text) {
  const trimmed = text.trim();
  if (!trimmed) return '';

  for (let len = Math.floor(trimmed.length / 2); len >= 20; len--) {
    const first = trimmed.slice(0, len).trim();
    const rest = trimmed.slice(len).trim();
    if (first && rest === first) return first;
  }

  return '';
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractGeminiText(data) {
  return (data.candidates || [])
    .flatMap(candidate => candidate.content?.parts || [])
    .map(part => part.text || '')
    .join('')
    .trim();
}

async function imageUrlToInlineData(src) {
  let blob;
  try {
    blob = await fetchImageBlob(src);
  } catch {
    blob = await fetchImageBlob(`https://api.allorigins.win/raw?url=${encodeURIComponent(src)}`);
  }

  const mimeType = getImageMimeType(blob, src);
  if (!mimeType) {
    throw new Error(`Image fetch returned ${blob.type || 'unknown content type'}`);
  }
  if (blob.size > MAX_IMAGE_BYTES) {
    throw new Error('Image is larger than 20 MB');
  }

  return {
    mimeType,
    data: await blobToBase64(blob)
  };
}

async function fetchImageBlob(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Image fetch returned ${res.status}`);
  return res.blob();
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(new Error('Could not read image data'));
    reader.readAsDataURL(blob);
  });
}

function getImageMimeType(blob, src) {
  if (blob.type && blob.type.startsWith('image/')) return blob.type;

  try {
    const pathname = new URL(src).pathname.toLowerCase();
    if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
    if (pathname.endsWith('.png')) return 'image/png';
    if (pathname.endsWith('.webp')) return 'image/webp';
    if (pathname.endsWith('.gif')) return 'image/gif';
    if (pathname.endsWith('.avif')) return 'image/avif';
  } catch {
    return '';
  }

  return '';
}

function cleanErrorMessage(err) {
  return (err && err.message ? err.message : String(err)).replace(/\s+/g, ' ').trim();
}

function getDisplayTitleFromUrl(pageUrl) {
  try {
    const url = new URL(pageUrl);
    return url.hostname + url.pathname.replace(/\/$/, '');
  } catch {
    return pageUrl;
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
