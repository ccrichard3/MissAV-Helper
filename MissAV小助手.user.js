// ==UserScript==
// @name               MissAV小助手
// @name:zh-CN         MissAV小助手
// @description        Remove noisy ads, keep playback stable, and expose only the highest-resolution HLS download.
// @description:zh-CN  合并增强和下载功能：去广告、稳定播放、只显示最高分辨率下载。
// @author             ccrichard3
// @namespace          ccrichard3.missav.helper
// @license            MIT
// @match              *://missav.ai/*
// @match              *://missav.ws/*
// @match              *://missav.live/*
// @match              *://missav123.com/*
// @match              *://missav.fans/*
// @match              *://missav.media/*
// @match              *://missav.com/*
// @match              *://thisav.com/*
// @grant              unsafeWindow
// @grant              GM_addStyle
// @grant              GM_xmlhttpRequest
// @connect            surrit.com
// @connect            nineyu.com
// @connect            missav.ai
// @connect            missav.ws
// @connect            missav.live
// @connect            missav123.com
// @connect            missav.fans
// @connect            missav.media
// @connect            *
// @run-at             document-start
// @version            2026.6.15.12
// ==/UserScript==

(() => {
    'use strict';

    const W = typeof unsafeWindow !== 'undefined' ? unsafeWindow : window;
    const nativeOpen = W.open ? W.open.bind(W) : window.open.bind(window);
    const AUTO_PAUSE_DISABLE = 1;
    const DEFAULT_DOWNLOAD_CONCURRENCY = 8;
    const MIN_DOWNLOAD_CONCURRENCY = 1;
    const MAX_DOWNLOAD_CONCURRENCY = 16;
    const PROBE_QUALITIES = [4320, 2160, 1440, 1080, 720, 480, 360];
    const STORE_DOWNLOAD_CONCURRENCY = 'missav-helper-download-concurrency';
    const STATE = {
        urls: [],
        best: null,
        panel: null,
        status: null,
        hlsPatched: false,
        fetchPatched: false,
        xhrPatched: false,
        mediaSrcPatched: false,
        mediaPausePatched: false,
        activeAbort: null,
        keyCache: new Map(),
        playlistCache: new Map(),
        invalidUrls: new Set(),
        downloadConcurrency: readStoredNumber(STORE_DOWNLOAD_CONCURRENCY, DEFAULT_DOWNLOAD_CONCURRENCY),
        refreshedAt: 0,
        statusText: '',
        statusError: false,
    };

    if (/^https:\/\/(missav|thisav)\.com\//i.test(location.href)) {
        location.replace(location.href.replace('missav.com', 'missav.live').replace('thisav.com', 'missav.live'));
        return;
    }

    earlyCapture();
    onReady(() => {
        if (isSecurityChallengePage()) {
            removeHelperPanel();
            return;
        }
        addStyles();
        installAdCleaner();
        installPlaybackHelpers();
        installDownloadPanel();
        refreshBestSoon();
    });

    function earlyCapture() {
        patchFetch();
        patchXHR();
        patchMediaSrc();
        patchMediaPauseGuard();
        patchHlsWhenReady();
        const timer = setInterval(() => {
            patchPlayerPauseGuard();
            if (patchHlsWhenReady()) clearInterval(timer);
        }, 150);
        setTimeout(() => clearInterval(timer), 15000);
    }

    function patchFetch() {
        if (!W.fetch || STATE.fetchPatched) return;
        const nativeFetch = W.fetch;
        W.fetch = function patchedMissavFetch(input, init) {
            try {
                const url = typeof input === 'string' ? input : input && input.url;
                rememberM3u8(url, 'fetch');
            } catch (_) {}
            return nativeFetch.apply(this, arguments);
        };
        STATE.fetchPatched = true;
    }

    function patchXHR() {
        const proto = W.XMLHttpRequest && W.XMLHttpRequest.prototype;
        if (!proto || STATE.xhrPatched) return;
        const nativeOpen = proto.open;
        proto.open = function patchedMissavXhrOpen(method, url) {
            rememberM3u8(url, 'xhr');
            return nativeOpen.apply(this, arguments);
        };
        STATE.xhrPatched = true;
    }

    function patchMediaSrc() {
        if (STATE.mediaSrcPatched || !W.HTMLMediaElement) return;
        const proto = W.HTMLMediaElement.prototype;
        const desc = Object.getOwnPropertyDescriptor(proto, 'src');
        if (!desc || !desc.set || !desc.get) return;
        Object.defineProperty(proto, 'src', {
            configurable: true,
            enumerable: desc.enumerable,
            get() {
                return desc.get.call(this);
            },
            set(value) {
                rememberM3u8(value, 'media.src');
                return desc.set.call(this, value);
            },
        });
        STATE.mediaSrcPatched = true;
    }

    function patchMediaPauseGuard() {
        if (STATE.mediaPausePatched || !W.HTMLMediaElement) return;
        const proto = W.HTMLMediaElement.prototype;
        const nativePause = proto.pause;
        proto.pause = function patchedMissavMediaPause() {
            if (AUTO_PAUSE_DISABLE === 1 && shouldBlockAutoPause(this)) return;
            return nativePause.apply(this, arguments);
        };
        STATE.mediaPausePatched = true;
    }

    function patchPlayerPauseGuard() {
        if (W.player && !W.player.__mahPausePatched && typeof W.player.pause === 'function') {
            const nativePause = W.player.pause.bind(W.player);
            W.player.pause = function patchedMissavPlayerPause() {
                if (AUTO_PAUSE_DISABLE === 1 && isPageInactive()) return;
                return nativePause();
            };
            W.player.__mahPausePatched = true;
        }
        if (W.Plyr && W.Plyr.prototype && !W.Plyr.prototype.__mahPausePatched && typeof W.Plyr.prototype.pause === 'function') {
            const nativePlyrPause = W.Plyr.prototype.pause;
            W.Plyr.prototype.pause = function patchedMissavPlyrPause() {
                if (AUTO_PAUSE_DISABLE === 1 && isPageInactive()) return;
                return nativePlyrPause.apply(this, arguments);
            };
            W.Plyr.prototype.__mahPausePatched = true;
        }
    }

    function shouldBlockAutoPause(video) {
        if (!isPageInactive()) return false;
        if (!video || video.tagName !== 'VIDEO') return false;
        return video.matches('video.player, .plyr video, video');
    }

    function isPageInactive() {
        return document.hidden || !document.hasFocus();
    }

    function patchHlsWhenReady() {
        if (STATE.hlsPatched || !W.Hls || !W.Hls.prototype || !W.Hls.prototype.loadSource) return false;
        const proto = W.Hls.prototype;
        const nativeLoadSource = proto.loadSource;
        proto.loadSource = function patchedMissavHlsLoadSource(url) {
            rememberM3u8(url, 'hls.loadSource');
            return nativeLoadSource.apply(this, arguments);
        };
        STATE.hlsPatched = true;
        return true;
    }

    function rememberM3u8(url, source) {
        url = normalizeUrl(url);
        if (!url || !/\.m3u8(?:[?#]|$)/i.test(url)) return;
        if (/\{|\}|%7B|%7D|\$\{/i.test(url)) return;
        if (!STATE.urls.some(item => item.url === url)) {
            STATE.urls.push({
                url,
                source,
                height: heightFromUrl(url),
                at: Date.now(),
            });
            refreshBestSoon();
        }
    }

    function refreshBestSoon() {
        clearTimeout(refreshBestSoon.timer);
        refreshBestSoon.timer = setTimeout(() => {
            refreshBest().catch(err => setStatus(`解析失败：${err.message || err}`, true));
        }, 200);
    }

    async function refreshBest() {
        STATE.refreshedAt = Date.now();
        parsePageForM3u8();
        addDerivedQualityUrls();

        let candidates = getSortedCandidates();
        STATE.best = candidates[0] || null;
        renderPanel();

        const hasDirectCandidate = candidates.some(item => (item.height || heightFromUrl(item.url)) > 0);
        const masterCandidates = candidates
            .filter(item => isMasterUrl(item.url))
            .filter(item => !hasDirectCandidate || item.source !== 'derived');
        for (const master of masterCandidates) {
            try {
                const variants = await loadMasterVariants(master.url);
                for (const variant of variants) rememberM3u8(variant.url, `master:${master.source}`);
            } catch (err) {
                if (!hasDirectCandidate) {
                    setStatus(`主列表暂时不可读，已用页面捕获结果：${err.message || err}`, false);
                }
            }
        }

        candidates = getSortedCandidates();
        STATE.best = await pickBestPlayableCandidate(candidates);
        renderPanel();
        return STATE.best;
    }

    function getSortedCandidates() {
        const candidates = uniqueByUrl(STATE.urls)
            .filter(item => item && item.url && !STATE.invalidUrls.has(item.url))
            .map(item => ({ ...item }));
        candidates.sort(compareCandidates);
        return candidates;
    }

    async function pickBestPlayableCandidate(candidates) {
        for (const item of candidates) {
            if (!item || !item.url || STATE.invalidUrls.has(item.url)) continue;
            if (!needsProbe(item)) return item;

            try {
                const playlist = await getPlayablePlaylist(item.url);
                const segments = parseSegments(playlist.text, playlist.url);
                if (!segments.length) throw new Error('分片列表为空');
                return {
                    ...item,
                    url: playlist.url || item.url,
                    height: item.height || heightFromUrl(playlist.url || item.url),
                };
            } catch (err) {
                STATE.invalidUrls.add(item.url);
                if (item.source !== 'derived' && !isNotFoundError(err)) {
                    setStatus(`跳过不可用清晰度 ${item.height || '未知'}p：${err.message || err}`);
                }
            }
        }
        return null;
    }

    function candidateHeight(item) {
        return item ? (item.height || heightFromUrl(item.url)) : 0;
    }

    function needsProbe(item) {
        return item.source === 'derived' || isMasterUrl(item.url);
    }

    function parsePageForM3u8() {
        const html = document.documentElement ? document.documentElement.innerHTML : '';
        extractRawM3u8(html).forEach(url => rememberM3u8(url, 'page'));
        extractPackedScripts(html).forEach(code => {
            extractRawM3u8(code).forEach(url => rememberM3u8(url, 'packed'));
        });
    }

    function extractRawM3u8(text) {
        if (!text) return [];
        const found = [];
        const re = /https?:\\?\/\\?\/[^\s"'<>\\]+?\.m3u8(?:\?[^\s"'<>\\]*)?/gi;
        let match;
        while ((match = re.exec(text))) {
            const url = normalizeUrl(match[0]);
            if (url) found.push(url);
        }
        return found;
    }

    function extractPackedScripts(text) {
        const out = [];
        const re = /eval\(function\(p,a,c,k,e,d\)\{[\s\S]*?\}\('((?:\\'|[^'])*)',\s*(\d+),\s*(\d+),\s*'((?:\\'|[^'])*)'\.split\('\|'\)/g;
        let match;
        while ((match = re.exec(text))) {
            try {
                const payload = unescapePackedString(match[1]);
                const base = Number(match[2]);
                const dict = unescapePackedString(match[4]).split('|');
                out.push(payload.replace(/\b\w+\b/g, token => {
                    const index = parseInt(token, base);
                    return Number.isFinite(index) && dict[index] ? dict[index] : token;
                }));
            } catch (_) {}
        }
        return out;
    }

    function unescapePackedString(value) {
        return value.replace(/\\'/g, "'").replace(/\\\\/g, '\\');
    }

    function addDerivedQualityUrls() {
        const urls = uniqueByUrl(STATE.urls).map(item => item.url);
        const hostsById = new Map();

        const addId = (id, host) => {
            if (!id) return;
            const cleanId = id.replace(/\\\//g, '/').split('/')[0];
            if (!cleanId) return;
            if (!hostsById.has(cleanId)) hostsById.set(cleanId, new Set());
            hostsById.get(cleanId).add(host || 'surrit.com');
        };

        for (const url of urls) {
            const match = url.match(/(?:https?:\/\/)?(?:www\.)?(surrit\.com|nineyu\.com)\/([^/?#]+)(?:\/|$)/i);
            if (match) addId(match[2], match[1]);
        }

        const html = document.documentElement ? document.documentElement.innerHTML : '';
        const idRe = /(surrit\.com|nineyu\.com)\\?\/([^\\/"'<>]+?)\\?\/(?:seek|(?:\d{3,4}p)|playlist)/gi;
        let match;
        while ((match = idRe.exec(html))) {
            addId(match[2], match[1].replace(/\\/g, ''));
        }

        const qualityButtons = Array.from(document.querySelectorAll('[data-plyr="quality"][value], button[value]'))
            .map(button => Number(button.value || button.getAttribute('value')))
            .filter(value => value > 0);
        const explicitQualities = STATE.urls
            .map(item => item.height || heightFromUrl(item.url))
            .filter(value => value > 0);
        const qualities = uniqueNumbers([...PROBE_QUALITIES, ...qualityButtons, ...explicitQualities]);

        for (const [id, hosts] of hostsById) {
            for (const host of hosts) {
                rememberM3u8(`https://${host}/${id}/playlist.m3u8`, 'derived');
                for (const height of qualities) {
                    rememberM3u8(`https://${host}/${id}/${height}p/video.m3u8`, 'derived');
                }
            }
        }
    }

    async function loadMasterVariants(masterUrl) {
        const text = await fetchText(masterUrl, 15000);
        if (!/#EXTM3U/i.test(text) || !/#EXT-X-STREAM-INF/i.test(text)) return [];
        const lines = text.split(/\r?\n/);
        const variants = [];
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line.startsWith('#EXT-X-STREAM-INF')) continue;
            const next = nextUriLine(lines, i + 1);
            if (!next) continue;
            const res = /RESOLUTION=(\d+)x(\d+)/i.exec(line);
            const bandwidth = /BANDWIDTH=(\d+)/i.exec(line);
            variants.push({
                url: new URL(next, masterUrl).href,
                height: res ? Number(res[2]) : heightFromUrl(next),
                bandwidth: bandwidth ? Number(bandwidth[1]) : 0,
                source: 'master',
            });
        }
        return variants.sort(compareCandidates);
    }

    function nextUriLine(lines, start) {
        for (let i = start; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line && !line.startsWith('#')) return line;
        }
        return '';
    }

    function compareCandidates(a, b) {
        const ah = a.height || heightFromUrl(a.url);
        const bh = b.height || heightFromUrl(b.url);
        if (bh !== ah) return bh - ah;
        if ((b.bandwidth || 0) !== (a.bandwidth || 0)) return (b.bandwidth || 0) - (a.bandwidth || 0);
        return scoreUrl(b.url) - scoreUrl(a.url);
    }

    function scoreUrl(url) {
        if (/\/video\.m3u8/i.test(url)) return 20;
        if (/\/playlist\.m3u8/i.test(url)) return 5;
        return 0;
    }

    function isMasterUrl(url) {
        return /\/playlist\.m3u8(?:[?#]|$)/i.test(url) || !heightFromUrl(url);
    }

    function heightFromUrl(url) {
        const match = String(url || '').match(/(?:^|\/)(\d{3,4})p(?:\/|[._-]|$)/i);
        return match ? Number(match[1]) : 0;
    }

    function uniqueByUrl(items) {
        const seen = new Set();
        return items.filter(item => {
            const url = item && item.url;
            if (!url || seen.has(url)) return false;
            seen.add(url);
            return true;
        });
    }

    function uniqueNumbers(items) {
        return Array.from(new Set(items)).sort((a, b) => b - a);
    }

    function normalizeUrl(url) {
        if (!url || typeof url !== 'string') return '';
        url = url.trim()
            .replace(/&amp;/g, '&')
            .replace(/\\\//g, '/')
            .replace(/^['"]|['"]$/g, '');
        try {
            return new URL(url, location.href).href;
        } catch (_) {
            return '';
        }
    }

    function installDownloadPanel() {
        const timer = setInterval(() => {
            if (isSecurityChallengePage()) {
                removeHelperPanel();
                clearInterval(timer);
                return;
            }
            const anchor = findPanelAnchor();
            if (!anchor) return;
            clearInterval(timer);
            if (!STATE.panel) {
                STATE.panel = document.createElement('section');
                STATE.panel.id = 'missav-merged-helper';
                anchor.appendChild(STATE.panel);
            }
            renderPanel();
        }, 250);
        setTimeout(() => clearInterval(timer), 15000);
    }

    function findPanelAnchor() {
        return document.querySelector('.order-first .mt-4') ||
            document.querySelector('.order-first') ||
            document.querySelector('main') ||
            document.body;
    }

    function renderPanel() {
        if (isSecurityChallengePage()) {
            removeHelperPanel();
            return;
        }
        if (!STATE.panel) return;
        const best = STATE.best;
        const label = best ? `${candidateHeight(best) || '最高'}p` : '解析中';
        const url = best ? best.url : '';

        STATE.panel.innerHTML = `
            <div class="mah-title">MissAV小助手</div>
            <div class="mah-row">
                <span class="mah-quality">${escapeHtml(label)}</span>
                <div class="mah-actions">
                    <button type="button" data-action="download-ts"${url ? '' : ' disabled'}>流式下载 TS</button>
                    <button type="button" data-action="browser-download"${url ? '' : ' disabled'}>浏览器下载</button>
                    <button type="button" data-action="stop" class="mah-stop"${STATE.activeAbort ? '' : ' disabled'}>停止</button>
                    <label class="mah-concurrency" title="流式下载 TS 的分片并发数">
                        并发
                        <input data-action="concurrency" type="number" min="${MIN_DOWNLOAD_CONCURRENCY}" max="${MAX_DOWNLOAD_CONCURRENCY}" step="1" value="${getDownloadConcurrency()}">
                    </label>
                </div>
            </div>
            <div class="mah-url" title="${escapeHtml(url)}">${escapeHtml(url || '等待播放器加载或点击刷新')}</div>
            <div class="mah-status${STATE.statusError ? ' mah-error' : ''}">${escapeHtml(STATE.statusText)}</div>
        `;
        STATE.status = STATE.panel.querySelector('.mah-status');
        STATE.panel.querySelector('[data-action="download-ts"]').addEventListener('click', () => downloadBestTs());
        STATE.panel.querySelector('[data-action="browser-download"]').addEventListener('click', () => triggerBrowserDownload(url));
        STATE.panel.querySelector('[data-action="stop"]').addEventListener('click', () => {
            if (STATE.activeAbort) STATE.activeAbort.abort();
        });
        STATE.panel.querySelector('[data-action="concurrency"]').addEventListener('change', event => {
            const value = saveDownloadConcurrency(event.target.value);
            event.target.value = value;
            setStatus(`并发已设置为 ${value}`);
        });
    }

    function getDownloadConcurrency() {
        return clampNumber(STATE.downloadConcurrency, MIN_DOWNLOAD_CONCURRENCY, MAX_DOWNLOAD_CONCURRENCY);
    }

    function saveDownloadConcurrency(value) {
        const concurrency = clampNumber(value, MIN_DOWNLOAD_CONCURRENCY, MAX_DOWNLOAD_CONCURRENCY);
        STATE.downloadConcurrency = concurrency;
        writeStoredNumber(STORE_DOWNLOAD_CONCURRENCY, concurrency);
        return concurrency;
    }

    function setStatus(text, isError = false) {
        STATE.statusText = text || '';
        STATE.statusError = Boolean(isError);
        if (!STATE.status) return;
        STATE.status.textContent = STATE.statusText;
        STATE.status.classList.toggle('mah-error', STATE.statusError);
    }

    function isSecurityChallengePage() {
        const text = [
            document.title || '',
            document.body ? document.body.innerText || '' : '',
        ].join('\n');
        const hasVerificationText = /正在进行安全验证|安全验证|验证您不是自动程序|checking your browser|verify you are human/i.test(text);
        const hasCloudflareText = /Cloudflare|Ray ID|安全服务防护恶意自动程序|cf-browser-verification|challenge-platform/i.test(text);
        return hasVerificationText && hasCloudflareText;
    }

    function removeHelperPanel() {
        if (STATE.activeAbort) {
            try {
                STATE.activeAbort.abort();
            } catch (_) {}
        }
        const panel = document.getElementById('missav-merged-helper');
        if (panel) panel.remove();
        STATE.panel = null;
        STATE.status = null;
    }

    function triggerBrowserDownload(url) {
        if (!url) return;
        const opened = nativeOpen(url, '_blank');
        if (!opened) {
            const a = document.createElement('a');
            a.href = url;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            document.body.appendChild(a);
            a.click();
            a.remove();
        }
        setStatus('已打开最高画质 m3u8；NDM/浏览器下载插件可接管，未接管时会打开或下载 playlist。');
    }

    async function downloadBestTs() {
        const aborter = new AbortController();
        STATE.activeAbort = aborter;
        renderPanel();

        try {
            const result = await collectBestTsWithFallback(aborter.signal);
            const filename = `${safeFileName(getTitle())}.ts`;
            saveBlobAsDownload(result.chunks, filename, 'video/mp2t');
            setStatus(`下载完成：${formatBytes(result.bytes)}，已交给浏览器保存到默认下载目录。`);
        } catch (err) {
            if (err && err.name === 'AbortError') {
                setStatus('已取消保存。');
            } else {
                setStatus(`下载中断：${err.message || err}`, true);
            }
        } finally {
            STATE.activeAbort = null;
            renderPanel();
        }
    }

    async function collectBestTsWithFallback(signal) {
        await refreshBest();
        const candidates = getTopResolutionCandidates();
        let lastErr = null;

        for (const candidate of candidates) {
            try {
                const playlist = await getPlayablePlaylist(candidate.url);
                const segments = parseSegments(playlist.text, playlist.url);
                if (!segments.length) throw new Error('分片列表为空');
                const best = {
                    ...candidate,
                    url: playlist.url || candidate.url,
                    height: candidate.height || heightFromUrl(playlist.url || candidate.url),
                };
                STATE.best = best;
                renderPanel();
                const result = await collectSegmentsConcurrently(segments, signal);
                return { best, chunks: result.chunks, bytes: result.bytes };
            } catch (err) {
                if (err && err.name === 'AbortError') throw err;
                lastErr = err;
                STATE.invalidUrls.add(candidate.url);
                setStatus(`最高分辨率 ${candidate.height || '未知'}p 下载失败：${err.message || err}`, true);
            }
        }

        throw lastErr || new Error('最高分辨率下载失败');
    }

    function getTopResolutionCandidates() {
        const candidates = getSortedCandidates();
        if (!candidates.length) return [];
        const topHeight = candidateHeight(candidates[0]);
        if (!topHeight) return candidates.slice(0, 1);
        return candidates.filter(candidate => candidateHeight(candidate) === topHeight);
    }

    async function collectSegmentsConcurrently(segments, signal) {
        const currentConcurrency = () => getDownloadConcurrency();
        let nextFetch = 0;
        let nextWrite = 0;
        let active = 0;
        let doneBytes = 0;
        let failed = null;
        const results = new Map();
        const chunks = [];
        let wakeWaiter = null;

        const abortError = () => {
            const err = new Error('已停止');
            err.name = 'AbortError';
            return err;
        };
        const wake = () => {
            if (wakeWaiter) {
                wakeWaiter();
                wakeWaiter = null;
            }
        };
        const waitForProgress = () => new Promise(resolve => {
            wakeWaiter = resolve;
        });
        const startMore = () => {
            const concurrency = currentConcurrency();
            while (!failed && !signal.aborted && active < concurrency && nextFetch < segments.length) {
                const index = nextFetch++;
                active++;
                fetchSegmentData(segments[index], signal)
                    .then(data => {
                        results.set(index, data);
                    })
                    .catch(err => {
                        failed = err;
                    })
                    .finally(() => {
                        active--;
                        wake();
                        startMore();
                    });
            }
        };

        setStatus(`开始下载：${segments.length} 个分片，并发 ${currentConcurrency()}`);
        startMore();

        while (nextWrite < segments.length) {
            while (!results.has(nextWrite)) {
                if (signal.aborted) throw abortError();
                if (failed) throw failed;
                if (active === 0 && nextFetch >= segments.length) {
                    throw new Error('下载任务提前结束');
                }
                await waitForProgress();
            }

            const buf = results.get(nextWrite);
            results.delete(nextWrite);
            chunks.push(buf);
            doneBytes += buf.byteLength || buf.length || 0;
            nextWrite++;

            const pct = (nextWrite / segments.length * 100).toFixed(2);
            setStatus(`下载中 ${nextWrite}/${segments.length}，${pct}% ，${formatBytes(doneBytes)}，并发 ${currentConcurrency()}`);
            startMore();
        }

        return { chunks, bytes: doneBytes };
    }

    function saveBlobAsDownload(chunks, filename, type) {
        const blob = new Blob(chunks, { type: type || 'application/octet-stream' });
        const blobUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        a.rel = 'noopener noreferrer';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(blobUrl), 60000);
    }

    async function getPlayablePlaylist(url) {
        if (STATE.playlistCache.has(url)) return STATE.playlistCache.get(url);
        let text = await fetchText(url, 20000);
        if (/#EXT-X-STREAM-INF/i.test(text)) {
            const variants = await loadMasterVariants(url);
            if (!variants.length) throw new Error('主列表没有可用清晰度');
            const best = variants[0];
            text = await fetchText(best.url, 20000);
            const result = { url: best.url, text };
            STATE.playlistCache.set(url, result);
            STATE.playlistCache.set(best.url, result);
            return result;
        }
        const result = { url, text };
        STATE.playlistCache.set(url, result);
        return result;
    }

    function parseSegments(text, baseUrl) {
        const lines = text.split(/\r?\n/).map(line => line.trim());
        const segments = [];
        let sequence = 0;
        let currentKey = null;

        for (const line of lines) {
            if (!line) continue;
            if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
                sequence = Number(line.split(':')[1]) || 0;
                continue;
            }
            if (line.startsWith('#EXT-X-KEY:')) {
                const attrs = parseM3u8Attrs(line.slice(line.indexOf(':') + 1));
                if (!attrs.METHOD || attrs.METHOD === 'NONE') {
                    currentKey = null;
                } else {
                    currentKey = {
                        method: attrs.METHOD,
                        uri: attrs.URI ? new URL(attrs.URI, baseUrl).href : '',
                        iv: attrs.IV ? parseHexIv(attrs.IV) : null,
                    };
                }
                continue;
            }
            if (line.startsWith('#EXT-X-MAP:')) {
                const attrs = parseM3u8Attrs(line.slice(line.indexOf(':') + 1));
                if (attrs.URI) {
                    segments.push({
                        url: new URL(attrs.URI, baseUrl).href,
                        key: currentKey,
                        sequence,
                        isMap: true,
                    });
                }
                continue;
            }
            if (line.startsWith('#')) continue;
            segments.push({
                url: new URL(line, baseUrl).href,
                key: currentKey,
                sequence,
                isMap: false,
            });
            sequence++;
        }

        return segments;
    }

    function parseM3u8Attrs(text) {
        const attrs = {};
        const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
        let match;
        while ((match = re.exec(text))) {
            attrs[match[1]] = match[2].replace(/^"|"$/g, '');
        }
        return attrs;
    }

    function parseHexIv(value) {
        value = String(value || '').replace(/^0x/i, '');
        const bytes = new Uint8Array(16);
        const padded = value.padStart(32, '0').slice(-32);
        for (let i = 0; i < 16; i++) {
            bytes[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
        }
        return bytes;
    }

    function sequenceIv(sequence) {
        const iv = new Uint8Array(16);
        const view = new DataView(iv.buffer);
        view.setUint32(12, sequence >>> 0);
        return iv;
    }

    async function fetchSegmentData(segment, signal) {
        let data = new Uint8Array(await fetchArrayBuffer(segment.url, 45000, signal, 4));
        if (!segment.key) return data;
        if (segment.key.method !== 'AES-128') {
            throw new Error(`不支持的加密方式：${segment.key.method}`);
        }
        if (!segment.key.uri) throw new Error('加密分片缺少 key URI');
        const key = await getDecryptKey(segment.key.uri, signal);
        const iv = segment.key.iv || sequenceIv(segment.sequence);
        return new Uint8Array(await decryptAes128(data, key, iv));
    }

    async function getDecryptKey(url, signal) {
        if (STATE.keyCache.has(url)) return STATE.keyCache.get(url);
        const data = new Uint8Array(await fetchArrayBuffer(url, 20000, signal, 3));
        if (data.byteLength !== 16) throw new Error(`key 长度异常：${data.byteLength}`);
        STATE.keyCache.set(url, data);
        return data;
    }

    async function decryptAes128(data, keyBytes, ivBytes) {
        if (!crypto.subtle) throw new Error('当前浏览器不支持 WebCrypto AES 解密');
        const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']);
        return crypto.subtle.decrypt({ name: 'AES-CBC', iv: ivBytes }, key, data);
    }

    async function fetchText(url, timeoutMs) {
        try {
            const response = await fetchWithTimeout(url, timeoutMs);
            return await response.text();
        } catch (err) {
            if (isHttpClientError(err)) throw err;
            return gmRequest(url, 'text', timeoutMs);
        }
    }

    async function fetchArrayBuffer(url, timeoutMs, outerSignal, retries) {
        let lastErr;
        for (let i = 0; i < retries; i++) {
            try {
                const response = await fetchWithTimeout(url, timeoutMs, outerSignal);
                return await response.arrayBuffer();
            } catch (err) {
                lastErr = err;
                if (outerSignal && outerSignal.aborted) throw err;
                if (isHttpClientError(err)) throw err;
                try {
                    return await gmRequest(url, 'arraybuffer', timeoutMs, outerSignal);
                } catch (gmErr) {
                    lastErr = gmErr;
                    if (isHttpClientError(gmErr)) throw gmErr;
                    await sleep(600 + i * 800);
                }
            }
        }
        throw lastErr || new Error('网络请求失败');
    }

    async function fetchWithTimeout(url, timeoutMs, outerSignal) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const abortOuter = () => controller.abort();
        if (outerSignal) outerSignal.addEventListener('abort', abortOuter, { once: true });
        try {
            const response = await fetch(url, {
                credentials: 'include',
                cache: 'no-store',
                signal: controller.signal,
            });
            if (!response.ok) {
                const err = new Error(`HTTP ${response.status}`);
                err.httpStatus = response.status;
                throw err;
            }
            return response;
        } finally {
            clearTimeout(timer);
            if (outerSignal) outerSignal.removeEventListener('abort', abortOuter);
        }
    }

    function gmRequest(url, responseType, timeoutMs, outerSignal) {
        const fn = typeof GM_xmlhttpRequest === 'function' ? GM_xmlhttpRequest : null;
        if (!fn) throw new Error('GM_xmlhttpRequest 不可用');
        return new Promise((resolve, reject) => {
            let request;
            let settled = false;
            const finish = (callback, value) => {
                if (settled) return;
                settled = true;
                if (outerSignal) outerSignal.removeEventListener('abort', abort);
                callback(value);
            };
            const abort = () => {
                if (settled) return;
                settled = true;
                if (outerSignal) outerSignal.removeEventListener('abort', abort);
                try {
                    if (request && request.abort) request.abort();
                } catch (_) {}
                const err = new Error('已停止');
                err.name = 'AbortError';
                reject(err);
            };
            if (outerSignal) {
                if (outerSignal.aborted) {
                    abort();
                    return;
                }
                outerSignal.addEventListener('abort', abort, { once: true });
            }
            request = fn({
                method: 'GET',
                url,
                responseType,
                timeout: timeoutMs,
                anonymous: false,
                headers: {
                    Referer: `${location.origin}/`,
                },
                onload: response => {
                    if (response.status >= 200 && response.status < 300) {
                        finish(resolve, responseType === 'text' ? response.responseText : response.response);
                    } else {
                        const err = new Error(`HTTP ${response.status}`);
                        err.httpStatus = response.status;
                        finish(reject, err);
                    }
                },
                onerror: () => finish(reject, new Error('GM 网络错误')),
                ontimeout: () => finish(reject, new Error('GM 请求超时')),
                onabort: abort,
            });
        });
    }

    function isHttpClientError(err) {
        return err && err.httpStatus >= 400 && err.httpStatus < 500;
    }

    function isNotFoundError(err) {
        return Boolean(err && (err.httpStatus === 404 || /(?:^|\s)(?:GM\s*)?HTTP 404(?:\s|$)/i.test(err.message || '')));
    }

    function installPlaybackHelpers() {
        const oldBackButton = document.getElementById('mah-back-player');
        if (oldBackButton) oldBackButton.remove();
        const timer = setInterval(() => {
            const video = document.querySelector('video.player, video');
            if (!video) return;
            clearInterval(timer);
            addSkipButtons(video);
            protectBackgroundPlayback(video);
        }, 300);
        setTimeout(() => clearInterval(timer), 15000);
    }

    function addSkipButtons(video) {
        const bar = document.querySelector('.order-first .mt-1.bg-black, .order-first div.flex.-mx-4, .plyr__controls');
        if (!bar || document.getElementById('mah-skip-wrap')) return;
        const wrap = document.createElement('span');
        wrap.id = 'mah-skip-wrap';
        wrap.innerHTML = `
            <button type="button" data-skip="-300">-5m</button>
            <button type="button" data-skip="300">+5m</button>
        `;
        wrap.querySelectorAll('button').forEach(button => {
            button.addEventListener('click', () => {
                video.currentTime = Math.max(0, video.currentTime + Number(button.dataset.skip || 0));
            });
        });
        bar.appendChild(wrap);
    }

    function protectBackgroundPlayback(video) {
        const resumeIfNeeded = () => {
            if (AUTO_PAUSE_DISABLE !== 1 || !isPageInactive()) return;
            document.querySelectorAll('video.player, .plyr video, video').forEach(item => {
                if (item.dataset.mahWasPlaying === '1' || item.matches('video.player')) {
                    item.play().catch(() => {});
                }
            });
            if (W.player && typeof W.player.play === 'function') {
                try {
                    W.player.play();
                } catch (_) {}
            }
        };
        video.addEventListener('play', () => {
            video.dataset.mahWasPlaying = '1';
        }, true);
        video.addEventListener('pause', () => {
            if (AUTO_PAUSE_DISABLE === 1 && isPageInactive()) {
                setTimeout(resumeIfNeeded, 30);
                setTimeout(resumeIfNeeded, 300);
            } else {
                video.dataset.mahWasPlaying = '0';
            }
        }, true);
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) setTimeout(resumeIfNeeded, 30);
        }, true);
        window.addEventListener('blur', () => setTimeout(resumeIfNeeded, 30), true);
        const timer = setInterval(() => {
            patchPlayerPauseGuard();
        }, 500);
        setTimeout(() => clearInterval(timer), 15000);
    }

    function installAdCleaner() {
        const clean = throttle(() => {
            const selectors = [
                'div[class^="root"]',
                'div[class*="fixed"][class*="right-"][class*="bottom-"]',
                'div[class*="lg:hidden"]',
                'div[class*="lg:block"]',
                'div.ts-outstream-video',
                'iframe',
                'ul.mb-4.list-none.text-nord14',
                '.prose',
                'img[alt="MissAV takeover Fanza"]',
            ];
            document.querySelectorAll(selectors.join(',')).forEach(el => {
                if (el.closest('#missav-merged-helper')) return;
                el.remove();
            });
        }, 500);
        clean();
        new MutationObserver(clean).observe(document.documentElement, { childList: true, subtree: true });
        try {
            W.open = () => null;
        } catch (_) {}
    }

    function addStyles() {
        const css = `
            #missav-merged-helper {
                margin: 12px 0;
                padding: 10px 12px;
                border: 1px solid rgba(254,98,142,.55);
                border-radius: 10px;
                background: rgba(9,8,17,.92);
                color: #fff;
                font-size: 13px;
                line-height: 1.5;
            }
            #missav-merged-helper .mah-title {
                font-weight: 700;
                color: #fe628e;
                margin-bottom: 6px;
            }
            #missav-merged-helper .mah-row {
                display: flex;
                gap: 8px;
                align-items: center;
                flex-wrap: wrap;
                margin-bottom: 6px;
            }
            #missav-merged-helper .mah-quality {
                display: inline-flex;
                align-items: center;
                min-height: 28px;
                border: 1px solid rgba(134,239,172,.45);
                border-radius: 999px;
                padding: 2px 10px;
                background: rgba(9,8,17,.92);
                color: #86efac;
                cursor: pointer;
                outline: none;
                font-weight: 700;
                box-sizing: border-box;
            }
            #missav-merged-helper .mah-quality option {
                background: #111827;
                color: #fff;
            }
            #missav-merged-helper .mah-url {
                max-width: 100%;
                overflow: hidden;
                text-overflow: ellipsis;
                white-space: nowrap;
                color: #cbd5e1;
                border-bottom: 1px dashed rgba(255,255,255,.15);
                padding-bottom: 5px;
                margin-bottom: 0;
            }
            #missav-merged-helper .mah-actions {
                display: inline-flex;
                gap: 6px;
                align-items: center;
                flex-wrap: wrap;
            }
            #missav-merged-helper button,
            #missav-merged-helper .mah-concurrency,
            #mah-skip-wrap button {
                display: inline-flex;
                align-items: center;
                min-height: 28px;
                border: 1px solid rgba(255,255,255,.25);
                border-radius: 999px;
                padding: 2px 10px;
                background: #1f2937;
                color: #fff;
                cursor: pointer;
                text-decoration: none;
                font: inherit;
                font-weight: 700;
                line-height: 1.35;
                box-sizing: border-box;
            }
            #missav-merged-helper .mah-concurrency {
                gap: 4px;
                cursor: default;
            }
            #missav-merged-helper .mah-concurrency input {
                width: 42px;
                min-width: 42px;
                border: 0;
                padding: 0;
                background: transparent;
                color: #fff;
                font: inherit;
                font-weight: 700;
                outline: none;
            }
            #missav-merged-helper button:hover,
            #mah-skip-wrap button:hover {
                background: #374151;
            }
            #missav-merged-helper button:disabled {
                opacity: .45;
                cursor: not-allowed;
            }
            #missav-merged-helper .mah-stop {
                border-color: rgba(248,113,113,.65);
                color: #fecaca;
            }
            #missav-merged-helper .mah-status {
                margin-top: 8px;
                color: #93c5fd;
            }
            #missav-merged-helper .mah-status.mah-error {
                color: #fca5a5;
            }
            #mah-skip-wrap {
                display: inline-flex;
                gap: 6px;
                margin-left: 6px;
            }
            div.my-2.text-sm.text-nord4.truncate,
            .truncate {
                white-space: normal !important;
                overflow: visible !important;
                text-overflow: clip !important;
            }
        `;
        if (typeof GM_addStyle === 'function') GM_addStyle(css);
        else {
            const style = document.createElement('style');
            style.textContent = css;
            document.head.appendChild(style);
        }
    }

    function getTitle() {
        const title = document.querySelector('.order-first .mt-4 h1, h1, span.font-medium');
        return (title && title.textContent.trim()) || document.title || 'missav-video';
    }

    function safeFileName(name) {
        return String(name || 'missav-video')
            .replace(/[\\/:*?"<>|]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 120) || 'missav-video';
    }

    function escapeHtml(text) {
        return String(text || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function formatBytes(bytes) {
        if (!Number.isFinite(bytes)) return '0 B';
        const units = ['B', 'KB', 'MB', 'GB'];
        let value = bytes;
        let unit = 0;
        while (value >= 1024 && unit < units.length - 1) {
            value /= 1024;
            unit++;
        }
        return `${value.toFixed(unit ? 2 : 0)} ${units[unit]}`;
    }

    function throttle(fn, delay) {
        let last = 0;
        let timer = null;
        return function throttled() {
            const now = Date.now();
            const rest = delay - (now - last);
            clearTimeout(timer);
            if (rest <= 0) {
                last = now;
                fn();
            } else {
                timer = setTimeout(() => {
                    last = Date.now();
                    fn();
                }, rest);
            }
        };
    }

    function readStoredNumber(key, fallback) {
        try {
            const raw = localStorage.getItem(key);
            if (raw === null || raw === '') return fallback;
            const value = Number(raw);
            return Number.isFinite(value) ? value : fallback;
        } catch (_) {
            return fallback;
        }
    }

    function writeStoredNumber(key, value) {
        try {
            localStorage.setItem(key, String(value));
        } catch (_) {}
    }

    function clampNumber(value, min, max) {
        const number = Math.round(Number(value));
        if (!Number.isFinite(number)) return min;
        return Math.min(max, Math.max(min, number));
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function onReady(fn) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', fn, { once: true });
        } else {
            fn();
        }
    }
})();
