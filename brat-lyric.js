(function BratLyricsExtension() {
    const CURRENT_VERSION = "2.0.0";    
    const UPDATE_CHECK_URL = "https://raw.githubusercontent.com/Kiano-Ksl/brat-lyrics-spicetify/main/version.json";
    const GITHUB_REPO_URL = "https://github.com/Kiano-Ksl/brat-lyrics-spicetify";   
    const SPICY_API_URL = "https://api.spicylyrics.org/query";
    const SPICY_CLIENT_VERSION = "5.18.0";
/
    if (!window.Spicetify || !Spicetify.Player || !document.body) {
        setTimeout(BratLyricsExtension, 250);
        return;
    }

    if (typeof window.__BRAT_LYRICS_CLEANUP__ === "function") {
        try {
            window.__BRAT_LYRICS_CLEANUP__();
        } catch (_) {}
    }

    class BratLyricParser {
        static cleanText(rawText) {
            return (rawText || "")
                .replace(/[[\]()\\/"♪♫]/g, "")
                .replace(/\s+/g, " ")
                .trim()
                .toLowerCase();
        }

        static parseTime(timeStr) {
            if (typeof timeStr === "number") return timeStr;
            if (!timeStr) return 0;
            const str = String(timeStr).trim();
            if (str.endsWith("ms")) return parseFloat(str) / 1000;
            if (str.endsWith("s")) return parseFloat(str);

            const parts = str.split(":").map(Number);
            if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
            if (parts.length === 2) return parts[0] * 60 + parts[1];
            return parseFloat(str) || 0;
        }

        static fromSpicyLyricsJson(rawPayload, allowLineFallback = false) {
            if (!rawPayload) return null;

            let data = rawPayload;
            if (typeof data === "string") {
                try {
                    data = JSON.parse(data);
                } catch (_) {
                    return null;
                }
            }

            if (Array.isArray(data?.queries)) {
                const lyricQuery = data.queries.find((q) => q?.result?.data);
                data = lyricQuery?.result?.data || data;
                if (typeof data === "string") {
                    try {
                        data = JSON.parse(data);
                    } catch (_) {
                        return null;
                    }
                }
            }

            const syncType = String(data?.Type || data?.type || "");
            const contentList = data?.Content || data?.content || data?.Lines || data?.lines;
            if (!Array.isArray(contentList) || contentList.length === 0) return null;

            let maxTimestamp = 0;
            for (const item of contentList) {
                const t = Number(item?.Lead?.EndTime ?? item?.EndTime ?? item?.StartTime ?? 0);
                if (t > maxTimestamp) maxTimestamp = t;
            }
            const timeDivisor = maxTimestamp > 1800 ? 1000 : 1;

            if (syncType.toLowerCase() === "syllable") {
                const lines = [];

                for (let i = 0; i < contentList.length; i++) {
                    const block = contentList[i];
                    const lead = block?.Lead || block?.lead || block;
                    const syllables = lead?.Syllables || lead?.syllables;
                    if (!Array.isArray(syllables) || syllables.length === 0) continue;

                    const words = [];
                    let wordBuffer = "";
                    let wordStart = null;
                    let wordEnd = null;

                    for (let s = 0; s < syllables.length; s++) {
                        const syl = syllables[s];
                        const rawSylText = String(syl?.Text ?? syl?.text ?? "");
                        const sStart = Number(syl?.StartTime ?? syl?.startTime ?? 0) / timeDivisor;
                        const sEnd = Number(syl?.EndTime ?? syl?.endTime ?? sStart + 0.2) / timeDivisor;
                        const isPart = Boolean(syl?.IsPartOfWord ?? syl?.isPartOfWord);

                        if (wordStart === null) wordStart = sStart;
                        wordEnd = sEnd;
                        wordBuffer += rawSylText.trim();

                        if (!isPart || /\s$/.test(rawSylText) || s === syllables.length - 1) {
                            const cleanedWord = this.cleanText(wordBuffer);
                            if (cleanedWord) {
                                words.push({
                                    text: cleanedWord,
                                    startTime: Number(wordStart.toFixed(3)),
                                    endTime: Number(wordEnd.toFixed(3))
                                });
                            }
                            wordBuffer = "";
                            wordStart = null;
                        }
                    }

                    if (words.length > 0) {
                        lines.push({
                            startTime: words[0].startTime,
                            endTime: words[words.length - 1].endTime,
                            text: words.map((w) => w.text).join(" "),
                            words
                        });
                    }
                }

                return lines.length > 0 ? { lines, isWordSynced: true } : null;
            }

            if (syncType.toLowerCase() === "line" && allowLineFallback) {
                const lines = [];

                for (let i = 0; i < contentList.length; i++) {
                    const block = contentList[i];
                    const nextBlock = contentList[i + 1];
                    const rawText = String(block?.Text ?? block?.text ?? "");
                    const cleaned = this.cleanText(rawText);
                    if (!cleaned) continue;

                    const start = Number(block?.StartTime ?? block?.startTime ?? 0) / timeDivisor;
                    const endRaw = Number(block?.EndTime ?? block?.endTime ?? 0) / timeDivisor;
                    const nextStart = nextBlock
                        ? Number(nextBlock?.StartTime ?? nextBlock?.startTime ?? start + 3.5) / timeDivisor
                        : start + 3.5;
                    const end = endRaw > start ? endRaw : nextStart;

                    const words = this.fallbackSplitWords(cleaned, start, end);
                    if (words.length > 0) {
                        lines.push({
                            startTime: start,
                            endTime: end,
                            text: words.map((w) => w.text).join(" "),
                            words
                        });
                    }
                }

                return lines.length > 0 ? { lines, isWordSynced: false } : null;
            }

            return null;
        }

        static fromLyricsPlusJson(data, allowLineFallback = false) {
            const rawLyrics = data?.lyrics;
            if (!Array.isArray(rawLyrics) || rawLyrics.length === 0) return null;

            const hasSyllables = rawLyrics.some(
                (l) => Array.isArray(l.syllabus) && l.syllabus.length > 0
            );

            if (!hasSyllables && !allowLineFallback) {
                return null;
            }

            const lines = [];

            for (let i = 0; i < rawLyrics.length; i++) {
                const line = rawLyrics[i];
                const nextLine = rawLyrics[i + 1];

                const lineStart = Number(line.time || 0) / 1000;
                const lineDur = Number(line.duration || 0) / 1000;
                const lineEnd =
                    lineDur > 0
                        ? lineStart + lineDur
                        : nextLine
                        ? Number(nextLine.time) / 1000
                        : lineStart + 3.5;

                const cleanedLine = this.cleanText(line.text || "");
                if (!cleanedLine) continue;

                const words = [];

                if (Array.isArray(line.syllabus) && line.syllabus.length > 0) {
                    let wordBuffer = "";
                    let wordStart = null;
                    let wordEnd = null;

                    for (let s = 0; s < line.syllabus.length; s++) {
                        const syl = line.syllabus[s];
                        if (syl.isBackground) continue;

                        const rawSyl = String(syl.text || "");
                        const startsWithSpace = /^\s/.test(rawSyl);
                        const endsWithSpace = /\s$/.test(rawSyl);

                        if (startsWithSpace && wordBuffer) {
                            const cw = this.cleanText(wordBuffer);
                            if (cw) {
                                words.push({
                                    text: cw,
                                    startTime: Number(wordStart.toFixed(3)),
                                    endTime: Number(wordEnd.toFixed(3))
                                });
                            }
                            wordBuffer = "";
                            wordStart = null;
                        }

                        const sStart = Number(syl.time || 0) / 1000;
                        const sEnd = sStart + Number(syl.duration || 180) / 1000;

                        if (wordStart === null) wordStart = sStart;
                        wordEnd = sEnd;
                        wordBuffer += rawSyl.trim();

                        if (endsWithSpace || s === line.syllabus.length - 1) {
                            const cw = this.cleanText(wordBuffer);
                            if (cw) {
                                words.push({
                                    text: cw,
                                    startTime: Number(wordStart.toFixed(3)),
                                    endTime: Number(wordEnd.toFixed(3))
                                });
                            }
                            wordBuffer = "";
                            wordStart = null;
                        }
                    }
                }

                if (words.length === 0) {
                    if (!allowLineFallback) continue;
                    words.push(...this.fallbackSplitWords(cleanedLine, lineStart, lineEnd));
                }

                lines.push({
                    startTime: words[0]?.startTime ?? lineStart,
                    endTime: words[words.length - 1]?.endTime ?? lineEnd,
                    text: words.map((w) => w.text).join(" "),
                    words
                });
            }

            return lines.length > 0 ? { lines, isWordSynced: hasSyllables } : null;
        }

        static fromTTML(rawInput, allowLineFallback = false) {
            if (!rawInput) return null;

            let ttmlXml = rawInput;
            if (typeof ttmlXml === "string" && ttmlXml.trim().startsWith("{")) {
                try {
                    const parsedJson = JSON.parse(ttmlXml);
                    ttmlXml =
                        parsedJson?.ttml ||
                        parsedJson?.lyrics ||
                        parsedJson?.content ||
                        parsedJson?.data ||
                        "";
                } catch (_) {
                    return null;
                }
            }

            if (typeof ttmlXml !== "string" || !ttmlXml.includes("<p")) return null;

            const parser = new DOMParser();
            const doc = parser.parseFromString(ttmlXml, "text/xml");
            const pList = Array.from(doc.getElementsByTagName("p"));
            if (pList.length === 0) return null;

            let foundAnyTimedSpan = false;
            const lines = [];

            for (let i = 0; i < pList.length; i++) {
                const p = pList[i];
                const nextP = pList[i + 1];

                const lineStart = this.parseTime(p.getAttribute("begin"));
                const rawEnd = p.getAttribute("end");
                const lineEnd = rawEnd
                    ? this.parseTime(rawEnd)
                    : nextP
                    ? this.parseTime(nextP.getAttribute("begin"))
                    : lineStart + 3.5;

                const words = [];
                let wordBuffer = "";
                let wordStart = null;
                let wordEnd = null;

                const flushWord = () => {
                    const cw = this.cleanText(wordBuffer);
                    if (cw && wordStart !== null) {
                        words.push({
                            text: cw,
                            startTime: Number(wordStart.toFixed(3)),
                            endTime: Number((wordEnd ?? lineEnd).toFixed(3))
                        });
                    }
                    wordBuffer = "";
                    wordStart = null;
                    wordEnd = null;
                };

                const walkNodes = (parentNode) => {
                    for (const node of Array.from(parentNode.childNodes)) {
                        if (node.nodeType === 1) {
                            const role =
                                node.getAttribute("ttm:role") || node.getAttribute("role") || "";
                            if (role.includes("x-bg") || role.includes("x-translation")) continue;

                            const b = node.getAttribute("begin");
                            const e = node.getAttribute("end");

                            const childSpans = node.getElementsByTagName("span");
                            if (childSpans.length > 0) {
                                walkNodes(node);
                                continue;
                            }

                            const textVal = node.textContent || "";
                            if (b) {
                                foundAnyTimedSpan = true;
                                const sStart = this.parseTime(b);
                                const sEnd = e ? this.parseTime(e) : sStart + 0.2;

                                if (/^\s/.test(textVal) && wordBuffer) {
                                    flushWord();
                                }
                                if (wordStart === null) wordStart = sStart;
                                wordEnd = sEnd;
                                wordBuffer += textVal.trim();

                                if (/\s$/.test(textVal)) {
                                    flushWord();
                                }
                            } else {
                                wordBuffer += textVal;
                            }
                        } else if (node.nodeType === 3) {
                            if (/\s/.test(node.nodeValue || "")) {
                                flushWord();
                            }
                        }
                    }
                };

                walkNodes(p);
                flushWord();

                const fullCleaned = this.cleanText(p.textContent || "");
                if (!fullCleaned) continue;

                if (words.length === 0) {
                    if (!allowLineFallback) continue;
                    words.push(...this.fallbackSplitWords(fullCleaned, lineStart, lineEnd));
                }

                lines.push({
                    startTime: words[0]?.startTime ?? lineStart,
                    endTime: words[words.length - 1]?.endTime ?? lineEnd,
                    text: words.map((w) => w.text).join(" "),
                    words
                });
            }

            if (!foundAnyTimedSpan && !allowLineFallback) return null;
            return lines.length > 0 ? { lines, isWordSynced: foundAnyTimedSpan } : null;
        }

        static fromPaxsenixJson(rawInput) {
            if (!rawInput) return null;

            let data = rawInput;
            if (typeof data === "string") {
                if (data.trim().startsWith("<")) {
                    return this.fromTTML(data, false);
                }
                try {
                    data = JSON.parse(data);
                } catch (_) {
                    return null;
                }
            }

            if (typeof data?.ttml === "string" && data.ttml.includes("<p")) {
                return this.fromTTML(data.ttml, false);
            }
            if (typeof data?.lyrics === "string" && data.lyrics.includes("<p")) {
                return this.fromTTML(data.lyrics, false);
            }

            const rawArray = Array.isArray(data)
                ? data
                : Array.isArray(data.content)
                ? data.content
                : Array.isArray(data.lyrics)
                ? data.lyrics
                : null;

            if (!rawArray || rawArray.length === 0) return null;

            if (rawArray.some((item) => Array.isArray(item.syllabus))) {
                return this.fromLyricsPlusJson({ lyrics: rawArray, type: "Word" }, false);
            }

            const lines = [];
            let hasWordTimings = false;

            for (let i = 0; i < rawArray.length; i++) {
                const item = rawArray[i];
                const lineStart = Number(item.timestamp ?? item.startTime ?? item.time ?? 0) / 1000;
                const lineEnd = Number(item.endtime ?? item.endTime ?? lineStart * 1000 + 3000) / 1000;

                if (Array.isArray(item.text) && item.text.length > 0) {
                    hasWordTimings = true;
                    const words = [];
                    let wordBuffer = "";
                    let wordStart = null;
                    let wordEnd = null;

                    for (let s = 0; s < item.text.length; s++) {
                        const syl = item.text[s];
                        if (syl.background) continue;

                        const rawSyl = String(syl.text || "");
                        const sStart = Number(syl.timestamp ?? syl.time ?? lineStart * 1000) / 1000;
                        const sEnd = Number(syl.endtime ?? syl.endTime ?? sStart * 1000 + 200) / 1000;

                        if (wordStart === null) wordStart = sStart;
                        wordEnd = sEnd;
                        wordBuffer += rawSyl.trim();

                        const isEndOfWord =
                            syl.part === false ||
                            /\s$/.test(rawSyl) ||
                            s === item.text.length - 1;

                        if (isEndOfWord) {
                            const cw = this.cleanText(wordBuffer);
                            if (cw) {
                                words.push({
                                    text: cw,
                                    startTime: Number(wordStart.toFixed(3)),
                                    endTime: Number(wordEnd.toFixed(3))
                                });
                            }
                            wordBuffer = "";
                            wordStart = null;
                        }
                    }

                    if (words.length > 0) {
                        lines.push({
                            startTime: words[0].startTime,
                            endTime: words[words.length - 1].endTime,
                            text: words.map((w) => w.text).join(" "),
                            words
                        });
                    }
                }
            }

            return hasWordTimings && lines.length > 0 ? { lines, isWordSynced: true } : null;
        }

        static fromLRC(lrcText, allowLineFallback = false) {
            if (!lrcText || typeof lrcText !== "string") return null;

            const rawLines = lrcText.split("\n");
            const parsed = [];
            const lineTimeRgx = /\[(\d{2}):(\d{2}\.\d{2,3})\]/;
            const wordTimeRgx = /<(\d{2}):(\d{2}\.\d{2,3})>\s*([^<]+)/g;
            let hasELRC = false;

            for (const raw of rawLines) {
                const m = lineTimeRgx.exec(raw);
                if (!m) continue;

                const startTime = parseInt(m[1], 10) * 60 + parseFloat(m[2]);
                const body = raw.replace(lineTimeRgx, "").trim();

                const eWords = [];
                let wm;
                while ((wm = wordTimeRgx.exec(body)) !== null) {
                    const wTime = parseInt(wm[1], 10) * 60 + parseFloat(wm[2]);
                    const wText = this.cleanText(wm[3]);
                    if (wText) eWords.push({ text: wText, startTime: wTime });
                }

                if (eWords.length > 0) hasELRC = true;

                const plain = this.cleanText(body.replace(/<\d{2}:\d{2}\.\d{2,3}>/g, ""));
                if (plain) {
                    parsed.push({ startTime, plain, eWords });
                }
            }

            if (!hasELRC && !allowLineFallback) return null;
            if (parsed.length === 0) return null;

            const lines = parsed.map((item, idx) => {
                const nextStart = parsed[idx + 1] ? parsed[idx + 1].startTime : item.startTime + 3.5;
                let words = [];

                if (item.eWords.length > 0) {
                    words = item.eWords.map((w, wIdx) => ({
                        text: w.text,
                        startTime: w.startTime,
                        endTime: item.eWords[wIdx + 1] ? item.eWords[wIdx + 1].startTime : nextStart
                    }));
                } else {
                    words = this.fallbackSplitWords(item.plain, item.startTime, nextStart);
                }

                return {
                    startTime: words[0]?.startTime ?? item.startTime,
                    endTime: words[words.length - 1]?.endTime ?? nextStart,
                    text: words.map((w) => w.text).join(" "),
                    words
                };
            });

            return { lines, isWordSynced: hasELRC };
        }

        static fromSpotify(lyricsData, allowLineFallback = false) {
            const rawLines = lyricsData?.lines || [];
            const isSyllable = lyricsData?.syncType === "SYLLABLE_SYNCED";
            if (!isSyllable && !allowLineFallback) return null;

            const lines = [];
            for (let i = 0; i < rawLines.length; i++) {
                const cur = rawLines[i];
                const next = rawLines[i + 1];
                const startTime = parseInt(cur.startTimeMs, 10) / 1000;
                const nextStart = next ? parseInt(next.startTimeMs, 10) / 1000 : startTime + 3.5;
                const rawStr = String(cur.words || "");
                const cleaned = this.cleanText(rawStr);
                if (!cleaned) continue;

                let words = [];
                if (isSyllable && Array.isArray(cur.syllables) && cur.syllables.length > 0) {
                    let charIdx = 0;
                    let buf = "";
                    let wStart = null;
                    let wEnd = null;

                    for (let s = 0; s < cur.syllables.length; s++) {
                        const syl = cur.syllables[s];
                        const len = parseInt(syl.numChars || 0, 10);
                        const sStart = parseInt(syl.startTimeMs || cur.startTimeMs, 10) / 1000;
                        const sEnd = cur.syllables[s + 1]
                            ? parseInt(cur.syllables[s + 1].startTimeMs, 10) / 1000
                            : nextStart;

                        const chunk = rawStr.slice(charIdx, charIdx + len);
                        charIdx += len;

                        if (wStart === null) wStart = sStart;
                        wEnd = sEnd;
                        buf += chunk;

                        const nextChar = rawStr[charIdx];
                        if (!nextChar || /\s/.test(nextChar) || /\s$/.test(chunk)) {
                            if (/\s/.test(nextChar)) charIdx++;
                            const cw = this.cleanText(buf);
                            if (cw) {
                                words.push({
                                    text: cw,
                                    startTime: Number(wStart.toFixed(3)),
                                    endTime: Number(wEnd.toFixed(3))
                                });
                            }
                            buf = "";
                            wStart = null;
                        }
                    }
                }

                if (words.length === 0) {
                    if (!allowLineFallback) continue;
                    words = this.fallbackSplitWords(cleaned, startTime, nextStart);
                }

                lines.push({
                    startTime: words[0]?.startTime ?? startTime,
                    endTime: words[words.length - 1]?.endTime ?? nextStart,
                    text: words.map((w) => w.text).join(" "),
                    words
                });
            }

            return lines.length > 0 ? { lines, isWordSynced: isSyllable } : null;
        }

        static fallbackSplitWords(cleanLine, start, end) {
            const arr = cleanLine.split(" ").filter(Boolean);
            if (arr.length === 0) return [];

            const rawDuration = Math.max(0.35, end - start);
            const naturalDuration = Math.min(rawDuration * 0.86, Math.max(0.9, arr.length * 0.34));

            const weights = arr.map((w) => {
                const vowels = (w.match(/[aiueo]/gi) || []).length;
                const pauseBonus = w.endsWith(",") ? 0.75 : 0;
                return Math.max(1, vowels * 1.3 + w.length * 0.25 + pauseBonus);
            });
            const totalWeight = weights.reduce((a, b) => a + b, 0);

            let cursor = start;
            return arr.map((w, i) => {
                const wDur = (weights[i] / totalWeight) * naturalDuration;
                const sTime = cursor;
                const eTime = cursor + wDur;
                cursor = eTime;
                return {
                    text: w,
                    startTime: Number(sTime.toFixed(3)),
                    endTime: Number(eTime.toFixed(3))
                };
            });
        }
    }

    const interceptedSpicyCache = new Map();

    if (!window.__BRAT_FETCH_HOOKED__) {
        window.__BRAT_FETCH_HOOKED__ = true;
        const origFetch = window.fetch;
        window.fetch = async function (...args) {
            const response = await origFetch.apply(this, args);
            try {
                const url = String(args[0]?.url || args[0] || "");
                if (url.includes("spicylyrics.org") || url.includes("color-lyrics") || url.includes("lyrics")) {
                    const clone = response.clone();
                    clone.json().then((json) => {
                        const currentUri = Spicetify.Player?.data?.item?.uri;
                        if (currentUri) {
                            const parsed = BratLyricParser.fromSpicyLyricsJson(json, false);
                            if (parsed?.isWordSynced) {
                                interceptedSpicyCache.set(currentUri, {
                                    status: "ready",
                                    lines: parsed.lines
                                });
                            }
                        }
                    }).catch(() => {});
                }
            } catch (_) {}
            return response;
        };
    }

    class UnifiedLyricsService {
        constructor() {
            this.cache = new Map();
            this.abortController = null;

            this.lyricsPlusServers = [
                "https://lyricsplus.prjktla.my.id",
                "https://lyricsplus-seven.vercel.app",
                "https://lyricsplus.atomix.one",
                "https://lyricsplus.binimum.org"
            ];
        }

        async extractRichTrackMeta() {
            const data = Spicetify.Player.data;
            const item = data?.item || data?.track;
            if (!item) return null;

            const uri = item.uri || "";
            const trackId = uri.startsWith("spotify:track:") ? uri.split(":")[2] : null;
            const rawTitle = item.name || item.metadata?.title || "";
            const cleanTitle = rawTitle
                .replace(/\s*\(.*?(feat|ft|live|remaster|version).*?\)/gi, "")
                .replace(/\s*-\s*.*?(remaster|version|live|mono|stereo).*$/gi, "")
                .trim();

            const artist = item.artists?.[0]?.name || item.metadata?.artist_name || "";
            const album = item.album?.name || item.metadata?.album_title || "";
            const durationSec = Math.round(
                (item.duration?.milliseconds || Spicetify.Player.getDuration() || 0) / 1000
            );

            let isrc = item.external_ids?.isrc || item.metadata?.isrc || "";
            if (!isrc && trackId && Spicetify.CosmosAsync) {
                try {
                    const trackInfo = await Promise.race([
                        Spicetify.CosmosAsync.get(`https://api.spotify.com/v1/tracks/${trackId}`),
                        new Promise((_, rej) => setTimeout(rej, 1500))
                    ]);
                    if (trackInfo?.external_ids?.isrc) {
                        isrc = trackInfo.external_ids.isrc;
                    }
                } catch (_) {}
            }

            return { uri, trackId, title: cleanTitle || rawTitle, rawTitle, artist, album, durationSec, isrc };
        }

        async fetchTimeout(url, options = {}, signal, ms = 6000) {
            const ctrl = new AbortController();
            const id = setTimeout(() => ctrl.abort(), ms);
            const onAbort = () => ctrl.abort();
            signal.addEventListener("abort", onAbort, { once: true });

            try {
                return await fetch(url, { ...options, signal: ctrl.signal });
            } finally {
                clearTimeout(id);
                signal.removeEventListener("abort", onAbort);
            }
        }

        async readInstalledSpicyLyricsCache(trackId) {
            if (!trackId || !window.indexedDB) return null;
            try {
                const dbs = (await window.indexedDB.databases?.()) || [];
                for (const dbInfo of dbs) {
                    const dbName = dbInfo.name || "";
                    if (!/spicy|lyric/i.test(dbName)) continue;

                    const parsed = await new Promise((resolve) => {
                        const req = window.indexedDB.open(dbName);
                        req.onerror = () => resolve(null);
                        req.onsuccess = () => {
                            const db = req.result;
                            const storeNames = Array.from(db.objectStoreNames);
                            if (storeNames.length === 0) {
                                db.close();
                                resolve(null);
                                return;
                            }
                            try {
                                const tx = db.transaction(storeNames, "readonly");
                                let resolved = false;
                                storeNames.forEach((sName) => {
                                    const store = tx.objectStore(sName);
                                    const getAllReq = store.getAll();
                                    getAllReq.onsuccess = () => {
                                        const items = getAllReq.result || [];
                                        for (const entry of items) {
                                            const rawStr = JSON.stringify(entry || "");
                                            if (rawStr.includes(trackId) || rawStr.includes("Syllable")) {
                                                const p = BratLyricParser.fromSpicyLyricsJson(
                                                    entry?.data || entry?.value || entry,
                                                    false
                                                );
                                                if (p?.isWordSynced && !resolved) {
                                                    resolved = true;
                                                    resolve(p);
                                                }
                                            }
                                        }
                                    };
                                });
                                tx.oncomplete = () => {
                                    db.close();
                                    if (!resolved) resolve(null);
                                };
                                tx.onerror = () => {
                                    db.close();
                                    resolve(null);
                                };
                            } catch (_) {
                                db.close();
                                resolve(null);
                            }
                        };
                    });

                    if (parsed?.isWordSynced) return parsed;
                }
            } catch (_) {}
            return null;
        }

        async fetchLyrics() {
            if (this.abortController) this.abortController.abort();
            this.abortController = new AbortController();
            const { signal } = this.abortController;

            const meta = await this.extractRichTrackMeta();
            if (signal.aborted) return { status: "aborted" };
            if (!meta || (!meta.trackId && !meta.title)) {
                return { status: "no_track", lines: [] };
            }

            if (this.cache.has(meta.uri)) {
                return this.cache.get(meta.uri);
            }

            if (interceptedSpicyCache.has(meta.uri)) {
                const cached = interceptedSpicyCache.get(meta.uri);
                this.cache.set(meta.uri, cached);
                return cached;
            }

            let bestLineSyncedBackup = null;
            const saveLineBackup = (lines) => {
                if (!bestLineSyncedBackup && Array.isArray(lines) && lines.length > 0) {
                    bestLineSyncedBackup = { status: "ready", lines };
                }
            };

            const wordSyncTasks = [];

            if (meta.trackId) {
                wordSyncTasks.push(
                    (async () => {
                        const localSpicy = await this.readInstalledSpicyLyricsCache(meta.trackId);
                        if (localSpicy?.isWordSynced) {
                            return { status: "ready", lines: localSpicy.lines };
                        }
                        throw new Error();
                    })()
                );

                wordSyncTasks.push(
                    (async () => {
                        const res = await this.fetchTimeout(
                            SPICY_API_URL,
                            {
                                method: "POST",
                                headers: {
                                    "Content-Type": "application/json",
                                    "SpicyLyrics-Version": SPICY_CLIENT_VERSION
                                },
                                body: JSON.stringify({
                                    jobs: [
                                        {
                                            handler: "lyrics",
                                            args: { id: meta.trackId }
                                        }
                                    ],
                                    client: { version: SPICY_CLIENT_VERSION }
                                })
                            },
                            signal,
                            5500
                        );
                        if (!res.ok) throw new Error();
                        const json = await res.json();
                        const wordParsed = BratLyricParser.fromSpicyLyricsJson(json, false);
                        if (wordParsed?.isWordSynced) {
                            return { status: "ready", lines: wordParsed.lines };
                        }
                        const lineParsed = BratLyricParser.fromSpicyLyricsJson(json, true);
                        if (lineParsed) saveLineBackup(lineParsed.lines);
                        throw new Error();
                    })()
                );
            }

            if (meta.isrc) {
                wordSyncTasks.push(
                    (async () => {
                        const r = await this.fetchTimeout(
                            `https://lyrics-storage.binimum.org/${meta.isrc}.ttml`,
                            {},
                            signal,
                            4500
                        );
                        if (!r.ok) throw new Error();
                        const t = await r.text();
                        const p = BratLyricParser.fromTTML(t, false);
                        if (p?.isWordSynced) return { status: "ready", lines: p.lines };
                        throw new Error();
                    })()
                );
            }

            const lpParams = new URLSearchParams({
                title: meta.title,
                artist: meta.artist,
                album: meta.album,
                duration: String(meta.durationSec || ""),
                source: "apple,lyricsplus,musixmatch-word,qq,spotify"
            });
            if (meta.isrc) lpParams.set("isrc", meta.isrc);

            for (const host of this.lyricsPlusServers) {
                wordSyncTasks.push(
                    (async () => {
                        const r = await this.fetchTimeout(
                            `${host}/v2/lyrics/get?${lpParams.toString()}`,
                            {},
                            signal,
                            6000
                        );
                        if (!r.ok) throw new Error();
                        const json = await r.json();
                        const wordParsed = BratLyricParser.fromLyricsPlusJson(json, false);
                        if (wordParsed?.isWordSynced) {
                            return { status: "ready", lines: wordParsed.lines };
                        }
                        const lineParsed = BratLyricParser.fromLyricsPlusJson(json, true);
                        if (lineParsed) saveLineBackup(lineParsed.lines);
                        throw new Error();
                    })()
                );
            }

            for (const countryCode of ["US", "GB", "ID"]) {
                wordSyncTasks.push(
                    (async () => {
                        const term = encodeURIComponent(`${meta.artist} ${meta.title}`);
                        const itunesRes = await this.fetchTimeout(
                            `https://itunes.apple.com/search?term=${term}&country=${countryCode}&entity=song&limit=6`,
                            {},
                            signal,
                            5000
                        );
                        if (!itunesRes.ok) throw new Error();
                        const itunesJson = await itunesRes.json();
                        const results = itunesJson?.results || [];
                        if (results.length === 0) throw new Error();

                        let matchedSong = results[0];
                        let bestDelta = Infinity;
                        for (const item of results) {
                            const sec = Math.round((item.trackTimeMillis || 0) / 1000);
                            const delta = Math.abs(sec - meta.durationSec);
                            if (delta < bestDelta) {
                                bestDelta = delta;
                                matchedSong = item;
                            }
                        }

                        if (!matchedSong?.trackId) throw new Error();
                        const paxRes = await this.fetchTimeout(
                            `https://lyrics.paxsenix.org/apple-music/lyrics?id=${matchedSong.trackId}&ttml=true&v=2`,
                            {},
                            signal,
                            5500
                        );
                        if (!paxRes.ok) throw new Error();
                        const textData = await paxRes.text();
                        const parsed =
                            BratLyricParser.fromTTML(textData, false) ||
                            BratLyricParser.fromPaxsenixJson(textData);

                        if (parsed?.isWordSynced) {
                            return { status: "ready", lines: parsed.lines };
                        }
                        throw new Error();
                    })()
                );
            }

            if (meta.trackId && Spicetify.CosmosAsync) {
                wordSyncTasks.push(
                    (async () => {
                        const spUrl = `https://spclient.wg.spotify.com/color-lyrics/v2/track/${meta.trackId}?format=json&vocalRemoval=false&market=from_token`;
                        const spRes = await Spicetify.CosmosAsync.get(spUrl);
                        if (!spRes?.lyrics) throw new Error();
                        const spWord = BratLyricParser.fromSpotify(spRes.lyrics, false);
                        if (spWord?.isWordSynced) {
                            return { status: "ready", lines: spWord.lines };
                        }
                        if (spRes.lyrics.syncType === "LINE_SYNCED") {
                            const spLine = BratLyricParser.fromSpotify(spRes.lyrics, true);
                            if (spLine) saveLineBackup(spLine.lines);
                        }
                        throw new Error();
                    })()
                );
            }

            wordSyncTasks.push(
                (async () => {
                    const lrcParams = new URLSearchParams({
                        artist_name: meta.artist,
                        track_name: meta.title
                    });
                    if (meta.durationSec > 0) lrcParams.set("duration", String(meta.durationSec));
                    const lrcRes = await this.fetchTimeout(
                        `https://lrclib.net/api/get?${lrcParams.toString()}`,
                        {},
                        signal,
                        5500
                    );
                    if (!lrcRes.ok) throw new Error();
                    const lrcJson = await lrcRes.json();
                    if (!lrcJson?.syncedLyrics) throw new Error();

                    const eLrcParsed = BratLyricParser.fromLRC(lrcJson.syncedLyrics, false);
                    if (eLrcParsed?.isWordSynced) {
                        return { status: "ready", lines: eLrcParsed.lines };
                    }
                    const stdParsed = BratLyricParser.fromLRC(lrcJson.syncedLyrics, true);
                    if (stdParsed) saveLineBackup(stdParsed.lines);
                    throw new Error();
                })()
            );

            wordSyncTasks.push(
                (async () => {
                    const q = encodeURIComponent(`${meta.artist} ${meta.title}`);
                    const searchRes = await this.fetchTimeout(
                        `https://lrclib.net/api/search?q=${q}`,
                        {},
                        signal,
                        5500
                    );
                    if (!searchRes.ok) throw new Error();
                    const list = await searchRes.json();
                    if (!Array.isArray(list) || list.length === 0) throw new Error();

                    const syncedItem = list.find((item) => item?.syncedLyrics);
                    if (!syncedItem?.syncedLyrics) throw new Error();

                    const eLrc = BratLyricParser.fromLRC(syncedItem.syncedLyrics, false);
                    if (eLrc?.isWordSynced) {
                        return { status: "ready", lines: eLrc.lines };
                    }
                    const std = BratLyricParser.fromLRC(syncedItem.syncedLyrics, true);
                    if (std) saveLineBackup(std.lines);
                    throw new Error();
                })()
            );

            try {
                const fastestWordSync = await Promise.any(wordSyncTasks);
                if (signal.aborted) return { status: "aborted" };
                if (fastestWordSync?.status === "ready") {
                    this.cache.set(meta.uri, fastestWordSync);
                    return fastestWordSync;
                }
            } catch (_) {}

            if (signal.aborted) return { status: "aborted" };

            if (bestLineSyncedBackup) {
                this.cache.set(meta.uri, bestLineSyncedBackup);
                return bestLineSyncedBackup;
            }

            return { status: "empty", lines: [] };
        }
    }

    class StateStore {
        constructor() {
            this.storageKey = "brat_lyrics_pure_v8";
            const saved = this.load();
            const validTransitions = ["rigid", "smooth", "slide"];
            const initialTransition = validTransitions.includes(saved.transitionStyle)
                ? saved.transitionStyle
                : "smooth";

            this.state = {
                isOpen: false,
                displayMode: saved.displayMode || "word_zoom",
                colorFlipMode: saved.colorFlipMode || "random_1_3",
                transitionStyle: initialTransition,
                bgColor: saved.bgColor || "#ffffff",
                textColor: saved.textColor || "#000000",
                blurAmount: saved.blurAmount ?? 1.15,
                syncOffsetMs: saved.syncOffsetMs ?? 0,
                status: "idle",
                lines: []
            };
            this.listeners = new Set();
        }

        load() {
            try {
                return JSON.parse(window.localStorage.getItem(this.storageKey) || "{}");
            } catch (_) {
                return {};
            }
        }

        save() {
            try {
                window.localStorage.setItem(
                    this.storageKey,
                    JSON.stringify({
                        displayMode: this.state.displayMode,
                        colorFlipMode: this.state.colorFlipMode,
                        transitionStyle: this.state.transitionStyle,
                        bgColor: this.state.bgColor,
                        textColor: this.state.textColor,
                        blurAmount: this.state.blurAmount,
                        syncOffsetMs: this.state.syncOffsetMs
                    })
                );
            } catch (_) {}
        }

        setState(partial) {
            Object.assign(this.state, partial);
            if (
                "displayMode" in partial ||
                "colorFlipMode" in partial ||
                "transitionStyle" in partial ||
                "bgColor" in partial ||
                "textColor" in partial ||
                "blurAmount" in partial ||
                "syncOffsetMs" in partial
            ) {
                this.save();
            }
            this.listeners.forEach((fn) => fn(this.state, partial));
        }

        subscribe(fn) {
            this.listeners.add(fn);
            return () => this.listeners.delete(fn);
        }
    }

    class SyncEngine {
        constructor(store, callbacks) {
            this.store = store;
            this.onLineChange = callbacks.onLineChange;
            this.onWordChange = callbacks.onWordChange;

            this.rafId = null;
            this.activeLineIdx = -1;
            this.activeWordIdx = -1;

            this.lastRawMs = 0;
            this.lastPerfMs = performance.now();
        }

        reset() {
            this.activeLineIdx = -1;
            this.activeWordIdx = -1;
            this.lastRawMs = Spicetify.Player.getProgress() || 0;
            this.lastPerfMs = performance.now();
        }

        start() {
            if (this.rafId) return;
            this.reset();

            const loop = (now) => {
                if (!this.store.state.isOpen) {
                    this.stop();
                    return;
                }
                this.tick(now);
                this.rafId = requestAnimationFrame(loop);
            };
            this.rafId = requestAnimationFrame(loop);
        }

        stop() {
            if (this.rafId) {
                cancelAnimationFrame(this.rafId);
                this.rafId = null;
            }
        }

        getPreciseTimeSec(now) {
            const rawMs = Spicetify.Player.getProgress() || 0;
            let currentMs = rawMs;

            if (rawMs !== this.lastRawMs) {
                this.lastRawMs = rawMs;
                this.lastPerfMs = now;
            } else if (Spicetify.Player.isPlaying()) {
                const elapsed = Math.min(200, Math.max(0, now - this.lastPerfMs));
                currentMs = this.lastRawMs + elapsed;
            }

            const offsetSec = (this.store.state.syncOffsetMs || 0) / 1000;
            return currentMs / 1000 + offsetSec + 0.025;
        }

        binarySearch(arr, timeSec) {
            let low = 0;
            let high = arr.length - 1;
            let res = -1;
            while (low <= high) {
                const mid = (low + high) >>> 1;
                if (timeSec >= arr[mid].startTime) {
                    res = mid;
                    low = mid + 1;
                } else {
                    high = mid - 1;
                }
            }
            return res;
        }

        tick(now) {
            const { status, lines } = this.store.state;
            if (status !== "ready" || lines.length === 0) return;

            const t = this.getPreciseTimeSec(now);
            const lineIdx = this.binarySearch(lines, t);

            if (lineIdx !== this.activeLineIdx) {
                const prevLineIdx = this.activeLineIdx;
                this.activeLineIdx = lineIdx;
                this.activeWordIdx = -1;
                this.onLineChange(lineIdx >= 0 ? lines[lineIdx] : null, lineIdx, prevLineIdx);
            }

            if (this.activeLineIdx >= 0) {
                const line = lines[this.activeLineIdx];
                const words = line.words || [];
                const wordIdx = Math.max(0, this.binarySearch(words, t));

                if (wordIdx !== this.activeWordIdx) {
                    this.activeWordIdx = wordIdx;
                    this.onWordChange(wordIdx, line);
                }
            }
        }
    }

    class BratStageRenderer {
        constructor(store) {
            this.store = store;
            this.currentLine = null;
            this.currentWordIdx = -1;
            this.lockedWordSpans = [];
            this.linesUntilFlip = this.getRandomFlipCount();

            this.injectStyles();
            this.buildDOM();
        }

        getRandomFlipCount() {
            return Math.floor(Math.random() * 3) + 1;
        }

        handleAutoColorFlipOnNewLine() {
            const { colorFlipMode, bgColor, textColor } = this.store.state;
            if (colorFlipMode === "off") return;

            if (colorFlipMode === "every_1") {
                this.linesUntilFlip = 0;
            } else {
                this.linesUntilFlip -= 1;
            }

            if (this.linesUntilFlip <= 0) {
                this.linesUntilFlip = this.getRandomFlipCount();
                const nextBg = textColor;
                const nextFg = bgColor;

                this.inputBg.value = nextBg;
                this.inputFg.value = nextFg;
                this.store.setState({ bgColor: nextBg, textColor: nextFg });
            }
        }

        injectStyles() {
            let style = document.getElementById("brat-pure-styles");
            if (!style) {
                style = document.createElement("style");
                style.id = "brat-pure-styles";
                document.head.appendChild(style);
            }

            style.textContent = `
                .brat-overlay {
                    position: fixed;
                    inset: 0;
                    z-index: 99999;
                    display: none;
                    align-items: center;
                    justify-content: center;
                    padding: 40px;
                    transition: background-color 0.08s ease;
                    user-select: none;
                    overflow: hidden;
                }
                .brat-overlay.is-open {
                    display: flex;
                }
                .brat-squish-wrapper {
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    transform: scaleX(0.82);
                    transform-origin: center center;
                    filter: blur(var(--brat-blur, 1.15px)) contrast(1.12);
                }
                .brat-box {
                    font-family: Arial, "Helvetica Neue", Helvetica, sans-serif;
                    font-weight: 500;
                    text-transform: lowercase;
                    line-height: 1.04;
                    letter-spacing: -0.032em;
                    word-break: keep-all;
                    overflow-wrap: normal;
                    margin: 0 auto;
                    box-sizing: border-box;
                    transition: color 0.08s ease;
                }
                .brat-word-token {
                    display: inline-block;
                }
                .brat-word-token.is-hidden-slot {
                    opacity: 0;
                    pointer-events: none;
                }

                @keyframes bratSmoothFade {
                    0% {
                        opacity: 0;
                        filter: blur(9px);
                    }
                    100% {
                        opacity: 1;
                        filter: blur(0px);
                    }
                }

                @keyframes bratKineticSlide {
                    0% {
                        opacity: 0;
                        filter: blur(5px);
                        transform: translateY(22px) skewY(4deg);
                    }
                    100% {
                        opacity: 1;
                        filter: blur(0px);
                        transform: translateY(0) skewY(0deg);
                    }
                }

                .brat-word-token.fx-rigid,
                .brat-box.fx-line-rigid {
                    animation: none !important;
                    opacity: 1;
                }

                .brat-word-token.fx-smooth {
                    animation: bratSmoothFade 0.28s ease-out forwards;
                }
                .brat-box.fx-line-smooth {
                    animation: bratSmoothFade 0.32s ease-out forwards;
                }

                .brat-word-token.fx-slide,
                .brat-box.fx-line-slide {
                    animation: bratKineticSlide 0.24s cubic-bezier(0.16, 1, 0.3, 1) forwards;
                }

                .brat-hud {
                    position: absolute;
                    top: 24px;
                    left: 50%;
                    transform: translateX(-50%);
                    display: flex;
                    align-items: center;
                    gap: 24px;
                    padding: 8px 22px;
                    border-radius: 999px;
                    opacity: 0;
                    transition: opacity 0.22s ease;
                    z-index: 100001;
                    font-family: Arial, sans-serif;
                }
                .brat-hud:hover,
                .brat-hud.is-pinned {
                    opacity: 1;
                }
                .brat-hud-btn {
                    font-size: 22px;
                    font-weight: bold;
                    cursor: pointer;
                    background: none;
                    border: none;
                    padding: 4px 8px;
                    transition: transform 0.15s ease;
                }
                .brat-hud-btn:hover {
                    transform: scale(1.15);
                }
                .brat-panel {
                    position: absolute;
                    top: 52px;
                    left: 50%;
                    transform: translateX(-50%);
                    min-width: 330px;
                    border: 2px solid currentColor;
                    border-radius: 10px;
                    padding: 16px;
                    display: none;
                    flex-direction: column;
                    gap: 12px;
                    font-family: Arial, sans-serif;
                    font-size: 12.5px;
                    font-weight: bold;
                    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28);
                }
                .brat-panel.is-open {
                    display: flex;
                }
                .brat-row {
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                    gap: 12px;
                }
                .brat-select {
                    padding: 4px 8px;
                    border-radius: 6px;
                    border: 1.5px solid currentColor;
                    background: transparent;
                    color: inherit;
                    font-weight: bold;
                    font-size: 12px;
                    cursor: pointer;
                    outline: none;
                    max-width: 195px;
                }
                .brat-select option {
                    background: #141414;
                    color: #ffffff;
                }
                .brat-presets {
                    display: flex;
                    gap: 8px;
                }
                .brat-chip {
                    width: 22px;
                    height: 22px;
                    border-radius: 50%;
                    border: 1.5px solid currentColor;
                    cursor: pointer;
                    transition: transform 0.15s ease;
                }
                .brat-chip:hover {
                    transform: scale(1.18);
                }
                .brat-offset-ctrl {
                    display: flex;
                    align-items: center;
                    gap: 6px;
                }
                .brat-mini-btn {
                    border: 1.5px solid currentColor;
                    background: transparent;
                    color: inherit;
                    border-radius: 5px;
                    padding: 2px 7px;
                    font-weight: bold;
                    cursor: pointer;
                    font-size: 11.5px;
                }
                .brat-mini-btn:hover {
                    opacity: 0.75;
                }
            `;
        }

        buildDOM() {
            const {
                bgColor,
                textColor,
                blurAmount,
                syncOffsetMs,
                displayMode,
                colorFlipMode,
                transitionStyle
            } = this.store.state;

            this.overlay = document.createElement("div");
            this.overlay.className = "brat-overlay";
            this.overlay.style.setProperty("--brat-blur", `${blurAmount}px`);

            this.squishWrapper = document.createElement("div");
            this.squishWrapper.className = "brat-squish-wrapper";

            this.box = document.createElement("div");
            this.box.className = "brat-box";
            this.squishWrapper.appendChild(this.box);
            this.overlay.appendChild(this.squishWrapper);

            this.hud = document.createElement("div");
            this.hud.className = "brat-hud";

            this.btnGear = document.createElement("button");
            this.btnGear.className = "brat-hud-btn";
            this.btnGear.textContent = "⚙";
            this.btnGear.title = "Brat Lyrics Settings";

            this.btnFull = document.createElement("button");
            this.btnFull.className = "brat-hud-btn";
            this.btnFull.textContent = "[ ]";
            this.btnFull.title = "Fullscreen";

            this.btnClose = document.createElement("button");
            this.btnClose.className = "brat-hud-btn";
            this.btnClose.textContent = "✕";
            this.btnClose.title = "Close (Esc)";

            this.panel = document.createElement("div");
            this.panel.className = "brat-panel";

            const rowMode = document.createElement("div");
            rowMode.className = "brat-row";
            rowMode.innerHTML = `<span>Display Mode</span>`;
            this.selectDisplayMode = document.createElement("select");
            this.selectDisplayMode.className = "brat-select";
            this.selectDisplayMode.innerHTML = `
                <option value="word_zoom">Word by Word (Auto-Zoom)</option>
                <option value="word_lock">Word by Word (Locked Box)</option>
                <option value="full_line">Full Sentence (Instant Square)</option>
            `;
            this.selectDisplayMode.value = displayMode;
            rowMode.appendChild(this.selectDisplayMode);

            const rowTrans = document.createElement("div");
            rowTrans.className = "brat-row";
            rowTrans.innerHTML = `<span>Transition Style</span>`;
            this.selectTransition = document.createElement("select");
            this.selectTransition.className = "brat-select";
            this.selectTransition.innerHTML = `
                <option value="rigid">Rigid (Classic Instant)</option>
                <option value="smooth">Smooth Fade</option>
                <option value="slide">Kinetic Slide Up</option>
            `;
            this.selectTransition.value = transitionStyle;
            rowTrans.appendChild(this.selectTransition);

            const rowFlip = document.createElement("div");
            rowFlip.className = "brat-row";
            rowFlip.innerHTML = `<span>Auto Color Flip</span>`;
            this.selectColorFlip = document.createElement("select");
            this.selectColorFlip.className = "brat-select";
            this.selectColorFlip.innerHTML = `
                <option value="random_1_3">Random (Every 1-3 Lines)</option>
                <option value="every_1">Every Single Line</option>
                <option value="off">Off (Manual Colors)</option>
            `;
            this.selectColorFlip.value = colorFlipMode;
            rowFlip.appendChild(this.selectColorFlip);

            const rowPreset = document.createElement("div");
            rowPreset.className = "brat-row";
            rowPreset.innerHTML = `<span>Theme Presets</span>`;
            const presetBox = document.createElement("div");
            presetBox.className = "brat-presets";
            [
                { bg: "#ffffff", fg: "#000000", title: "Brat Video (White / Black)" },
                { bg: "#8ace00", fg: "#000000", title: "Brat Green (#8ACE00 / Black)" },
                { bg: "#000000", fg: "#ffffff", title: "Brat Dark (Black / White)" }
            ].forEach((p) => {
                const chip = document.createElement("button");
                chip.className = "brat-chip";
                chip.style.backgroundColor = p.bg;
                chip.title = p.title;
                chip.onclick = () => {
                    this.inputBg.value = p.bg;
                    this.inputFg.value = p.fg;
                    this.store.setState({ bgColor: p.bg, textColor: p.fg });
                };
                presetBox.appendChild(chip);
            });
            rowPreset.appendChild(presetBox);

            const rowBg = document.createElement("div");
            rowBg.className = "brat-row";
            rowBg.innerHTML = `<span>Background</span>`;
            this.inputBg = document.createElement("input");
            this.inputBg.type = "color";
            this.inputBg.value = bgColor;
            rowBg.appendChild(this.inputBg);

            const rowFg = document.createElement("div");
            rowFg.className = "brat-row";
            rowFg.innerHTML = `<span>Lyrics Text</span>`;
            this.inputFg = document.createElement("input");
            this.inputFg.type = "color";
            this.inputFg.value = textColor;
            rowFg.appendChild(this.inputFg);

            const rowOffset = document.createElement("div");
            rowOffset.className = "brat-row";
            rowOffset.innerHTML = `<span>Sync Offset</span>`;
            const offsetCtrl = document.createElement("div");
            offsetCtrl.className = "brat-offset-ctrl";

            const btnMinus = document.createElement("button");
            btnMinus.className = "brat-mini-btn";
            btnMinus.textContent = "-50ms";

            this.offsetLabel = document.createElement("span");
            this.offsetLabel.style.minWidth = "52px";
            this.offsetLabel.style.textAlign = "center";
            this.offsetLabel.textContent = `${syncOffsetMs >= 0 ? "+" : ""}${syncOffsetMs}ms`;

            const btnPlus = document.createElement("button");
            btnPlus.className = "brat-mini-btn";
            btnPlus.textContent = "+50ms";

            btnMinus.onclick = () => {
                const next = (this.store.state.syncOffsetMs || 0) - 50;
                this.offsetLabel.textContent = `${next >= 0 ? "+" : ""}${next}ms`;
                this.store.setState({ syncOffsetMs: next });
            };
            btnPlus.onclick = () => {
                const next = (this.store.state.syncOffsetMs || 0) + 50;
                this.offsetLabel.textContent = `${next >= 0 ? "+" : ""}${next}ms`;
                this.store.setState({ syncOffsetMs: next });
            };

            offsetCtrl.append(btnMinus, this.offsetLabel, btnPlus);
            rowOffset.appendChild(offsetCtrl);

            this.panel.append(
                rowMode,
                rowTrans,
                rowFlip,
                rowPreset,
                rowBg,
                rowFg,
                rowOffset
            );
            this.hud.append(this.btnGear, this.btnFull, this.btnClose, this.panel);
            this.overlay.appendChild(this.hud);
            document.body.appendChild(this.overlay);

            this.bindEvents();
            this.syncColors(bgColor, textColor);
        }

        bindEvents() {
            this.btnGear.onclick = () => {
                const open = this.panel.classList.toggle("is-open");
                this.hud.classList.toggle("is-pinned", open);
            };
            this.btnFull.onclick = () => {
                if (!document.fullscreenElement) {
                    this.overlay.requestFullscreen().catch(() => {});
                }
            };
            this.btnClose.onclick = () => {
                if (document.fullscreenElement) {
                    document.exitFullscreen();
                } else {
                    this.panel.classList.remove("is-open");
                    this.hud.classList.remove("is-pinned");
                    this.store.setState({ isOpen: false });
                }
            };
            this.selectDisplayMode.onchange = (e) => {
                this.store.setState({ displayMode: e.target.value });
            };
            this.selectTransition.onchange = (e) => {
                this.store.setState({ transitionStyle: e.target.value });
            };
            this.selectColorFlip.onchange = (e) => {
                this.linesUntilFlip = this.getRandomFlipCount();
                this.store.setState({ colorFlipMode: e.target.value });
            };
            this.inputBg.oninput = (e) => this.store.setState({ bgColor: e.target.value });
            this.inputFg.oninput = (e) => this.store.setState({ textColor: e.target.value });
        }

        syncColors(bg, fg) {
            this.overlay.style.backgroundColor = bg;
            this.overlay.style.color = fg;
            this.panel.style.backgroundColor = bg;
            this.panel.style.color = fg;
            this.btnGear.style.color = fg;
            this.btnFull.style.color = fg;
            this.btnClose.style.color = fg;
        }

        renderStatus(msg) {
            this.currentLine = null;
            this.currentWordIdx = -1;
            this.lockedWordSpans = [];
            this.box.dataset.renderedLineKey = "";
            this.box.className = "brat-box";
            this.box.style.width = "auto";
            this.box.style.textAlign = "center";
            this.box.style.textAlignLast = "center";
            this.box.style.fontSize = "76px";
            this.box.textContent = msg;
        }

        applyProportionalSquareGeometry(wordCount, justifyLastLine = false) {
            if (wordCount <= 1) {
                this.box.style.textAlign = "left";
                this.box.style.textAlignLast = "left";
            } else {
                this.box.style.textAlign = "justify";
                this.box.style.textAlignLast = justifyLastLine ? "justify" : "left";
            }

            const testFont = 100;
            this.box.style.fontSize = `${testFont}px`;
            this.box.style.width = "10px";
            const minWordWidth = this.box.scrollWidth;

            this.box.style.width = "max-content";
            const singleLineWidth = this.box.scrollWidth;
            const singleLineHeight = this.box.offsetHeight || testFont;

            let idealWidth = singleLineWidth;

            if (wordCount >= 2) {
                const areaSide = Math.sqrt(singleLineWidth * singleLineHeight * 1.18);
                const maxAllowedForFewWords =
                    wordCount === 2 ? singleLineWidth * 0.72 : singleLineWidth * 0.85;

                let low = minWordWidth;
                let high = Math.max(minWordWidth, Math.min(singleLineWidth, maxAllowedForFewWords));
                idealWidth = Math.max(low, Math.min(high, areaSide));

                for (let step = 0; step < 6; step++) {
                    const mid = (low + high) * 0.5;
                    this.box.style.width = `${mid}px`;
                    const visualWidth = mid * 0.82;
                    if (this.box.offsetHeight > visualWidth * 1.08) {
                        low = mid;
                    } else {
                        high = mid;
                    }
                }
                idealWidth = Math.ceil(high);
            }

            this.box.style.width = `${idealWidth}px`;
            const measuredHeight = this.box.offsetHeight;
            const visualBoxWidth = idealWidth * 0.82;

            const maxCanvasBox = Math.min(
                Math.floor(window.innerWidth * 0.52),
                Math.floor(window.innerHeight * 0.54),
                430
            );

            const dominantSide = Math.max(visualBoxWidth, measuredHeight, 1);
            const maxFontCap = wordCount <= 2 ? 112 : 96;
            const finalFont = Math.min(
                maxFontCap,
                Math.max(30, Math.floor(testFont * (maxCanvasBox / dominantSide)))
            );

            const scaleRatio = finalFont / testFont;
            this.box.style.fontSize = `${finalFont}px`;
            this.box.style.width = `${Math.ceil(idealWidth * scaleRatio)}px`;
        }

        renderLyricStage(lineObj, activeWordIndex, forceRebuild = false) {
            if (!lineObj || !lineObj.words || lineObj.words.length === 0) {
                this.renderStatus("...");
                return;
            }

            const { displayMode, transitionStyle } = this.store.state;
            const allWords = lineObj.words;
            const lineKey = `${displayMode}_${transitionStyle}_${lineObj.startTime}`;

            if (displayMode === "full_line") {
                if (!forceRebuild && this.box.dataset.renderedLineKey === lineKey) {
                    return;
                }
                this.box.dataset.renderedLineKey = lineKey;
                this.lockedWordSpans = [];
                this.box.className = "brat-box";
                this.box.textContent = lineObj.text;

                this.applyProportionalSquareGeometry(allWords.length, true);

                if (transitionStyle !== "rigid") {
                    void this.box.offsetWidth;
                    this.box.classList.add(`fx-line-${transitionStyle}`);
                }
                return;
            }

            if (displayMode === "word_lock") {
                if (
                    forceRebuild ||
                    this.box.dataset.renderedLineKey !== lineKey ||
                    this.lockedWordSpans.length !== allWords.length
                ) {
                    this.box.dataset.renderedLineKey = lineKey;
                    this.box.className = "brat-box";
                    this.box.innerHTML = "";
                    this.lockedWordSpans = [];

                    allWords.forEach((w, idx) => {
                        const span = document.createElement("span");
                        span.className = "brat-word-token is-hidden-slot";
                        span.textContent = w.text;
                        this.box.appendChild(span);
                        this.lockedWordSpans.push(span);
                        if (idx < allWords.length - 1) {
                            this.box.appendChild(document.createTextNode(" "));
                        }
                    });

                    this.applyProportionalSquareGeometry(allWords.length, false);
                }

                for (let i = 0; i < this.lockedWordSpans.length; i++) {
                    const span = this.lockedWordSpans[i];
                    if (i < activeWordIndex) {
                        span.className = "brat-word-token";
                    } else if (i === activeWordIndex) {
                        const targetClass =
                            transitionStyle === "rigid"
                                ? "brat-word-token"
                                : `brat-word-token fx-${transitionStyle}`;
                        if (span.className !== targetClass) {
                            span.className = "brat-word-token";
                            void span.offsetWidth;
                            span.className = targetClass;
                        }
                    } else {
                        span.className = "brat-word-token is-hidden-slot";
                    }
                }
                return;
            }

            this.box.dataset.renderedLineKey = "";
            this.lockedWordSpans = [];

            const visibleWords = allWords.slice(0, activeWordIndex + 1);
            const wordCount = visibleWords.length;

            this.box.className = "brat-box";
            this.box.innerHTML = "";

            visibleWords.forEach((w, idx) => {
                const span = document.createElement("span");
                span.className =
                    idx === activeWordIndex && transitionStyle !== "rigid"
                        ? `brat-word-token fx-${transitionStyle}`
                        : "brat-word-token";
                span.textContent = w.text;
                this.box.appendChild(span);
                if (idx < wordCount - 1) {
                    this.box.appendChild(document.createTextNode(" "));
                }
            });

            this.applyProportionalSquareGeometry(wordCount, false);
        }
    }

    function isNewerVersion(remoteVer, currentVer) {
        const cleanRemote = String(remoteVer || "").replace(/^v/i, "").trim();
        const cleanCurrent = String(currentVer || "").replace(/^v/i, "").trim();
        if (!cleanRemote || cleanRemote === cleanCurrent) return false;

        const rParts = cleanRemote.split(".").map((n) => parseInt(n, 10) || 0);
        const cParts = cleanCurrent.split(".").map((n) => parseInt(n, 10) || 0);
        const maxLen = Math.max(rParts.length, cParts.length);

        for (let i = 0; i < maxLen; i++) {
            const r = rParts[i] || 0;
            const c = cParts[i] || 0;
            if (r > c) return true;
            if (r < c) return false;
        }
        return false;
    }

    async function checkUpdate() {
        try {
            if (!UPDATE_CHECK_URL || UPDATE_CHECK_URL.includes("USERNAME/REPO_NAME")) {
                return;
            }

            const response = await fetch(`${UPDATE_CHECK_URL}?t=${Date.now()}`, {
                cache: "no-store"
            });
            if (!response.ok) return;

            const data = await response.json();
            const latestVersion = data?.version || data?.tag_name;
            const releaseNotes =
                data?.changelog ||
                data?.notes ||
                "Performance improvements and visual updates for Brat Lyrics.";
            const repoUrl = data?.url || GITHUB_REPO_URL;

            if (latestVersion && isNewerVersion(latestVersion, CURRENT_VERSION)) {
                if (!Spicetify.PopupModal) return;

                const modalContainer = document.createElement("div");
                modalContainer.style.cssText = `
                    font-family: Arial, Helvetica, sans-serif;
                    display: flex;
                    flex-direction: column;
                    gap: 14px;
                    padding: 6px 2px;
                    color: var(--spice-text, #ffffff);
                `;

                modalContainer.innerHTML = `
                    <div style="display: flex; align-items: center; gap: 12px; background: #8ace00; color: #000000; padding: 12px 16px; border-radius: 8px; font-weight: 900;">
                        <span style="font-size: 24px; filter: blur(0.6px);">brat</span>
                        <div>
                            <div style="font-size: 15px;">Update Available: v${latestVersion}</div>
                            <div style="font-size: 12px; font-weight: bold; opacity: 0.8;">Current version: v${CURRENT_VERSION}</div>
                        </div>
                    </div>
                    <div style="font-size: 13.5px; line-height: 1.5; opacity: 0.92;">
                        <strong>What's new:</strong><br/>
                        ${releaseNotes}
                    </div>
                    <div style="background: rgba(255,255,255,0.07); padding: 10px 14px; border-radius: 6px; font-size: 12.5px; line-height: 1.5;">
                        Run <code style="background: rgba(0,0,0,0.4); padding: 2px 6px; border-radius: 4px; color: #8ace00;">spicetify upgrade</code> or update directly via the <strong>Marketplace</strong> tab or GitHub repository.
                    </div>
                    <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 6px;">
                        <button id="brat-update-later-btn" style="padding: 8px 16px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.3); background: transparent; color: inherit; font-weight: bold; cursor: pointer;">
                            Later
                        </button>
                        <a href="${repoUrl}" target="_blank" rel="noopener noreferrer" style="padding: 8px 18px; border-radius: 999px; background: #8ace00; color: #000000; font-weight: 900; text-decoration: none; display: inline-flex; align-items: center;">
                            Open GitHub
                        </a>
                    </div>
                `;

                Spicetify.PopupModal.display({
                    title: "Brat Lyrics Auto-Update",
                    content: modalContainer,
                    isLarge: false
                });

                const closeBtn = modalContainer.querySelector("#brat-update-later-btn");
                if (closeBtn) {
                    closeBtn.onclick = () => Spicetify.PopupModal.hide();
                }
            }
        } catch (_) {}
    }

    const store = new StateStore();
    const service = new UnifiedLyricsService();
    const renderer = new BratStageRenderer(store);

    const syncEngine = new SyncEngine(store, {
        onLineChange: (lineObj, lineIdx, prevLineIdx) => {
            renderer.currentLine = lineObj;
            renderer.currentWordIdx = 0;

            if (!lineObj) {
                renderer.renderStatus("...");
                return;
            }

            if (prevLineIdx >= 0 && lineIdx !== prevLineIdx) {
                renderer.handleAutoColorFlipOnNewLine();
            }

            renderer.renderLyricStage(lineObj, 0, true);
        },
        onWordChange: (wordIdx, lineObj) => {
            renderer.currentLine = lineObj;
            renderer.currentWordIdx = wordIdx;
            renderer.renderLyricStage(lineObj, wordIdx, false);
        }
    });

    async function loadLyricsForCurrentSong() {
        syncEngine.reset();
        renderer.linesUntilFlip = renderer.getRandomFlipCount();
        store.setState({ status: "loading", lines: [] });
        renderer.renderStatus("...");

        const res = await service.fetchLyrics();
        if (res.status === "aborted") return;

        if (res.status === "ready") {
            store.setState({ status: "ready", lines: res.lines });
            syncEngine.tick(performance.now());
        } else if (res.status === "no_track") {
            store.setState({ status: "no_track", lines: [] });
            renderer.renderStatus("play a track first");
        } else {
            store.setState({ status: "empty", lines: [] });
            renderer.renderStatus("lyrics unavailable");
        }
    }

    function toggleOverlay() {
        const nextOpen = !store.state.isOpen;
        store.setState({ isOpen: nextOpen });
        if (nextOpen) {
            loadLyricsForCurrentSong();
        }
    }

    function mountSinglePlaybarButton() {
        if (!document.getElementById("brat-playbar-btn-css")) {
            const s = document.createElement("style");
            s.id = "brat-playbar-btn-css";
            s.textContent = `
                #brat-playbar-btn {
                    background: transparent;
                    border: none;
                    width: 32px;
                    height: 32px;
                    min-width: 32px;
                    display: inline-flex !important;
                    align-items: center;
                    justify-content: center;
                    cursor: pointer;
                    position: relative;
                    padding: 0;
                    margin: 0 3px;
                    transition: transform 0.15s ease;
                }
                #brat-playbar-btn:hover {
                    transform: scale(1.1);
                }
                #brat-playbar-btn.is-active::after {
                    content: "";
                    position: absolute;
                    bottom: 1px;
                    left: 50%;
                    transform: translateX(-50%);
                    width: 4px;
                    height: 4px;
                    border-radius: 50%;
                    background-color: #8ace00;
                }
                #brat-playbar-btn svg {
                    width: 18px;
                    height: 18px;
                    display: block;
                }
            `;
            document.head.appendChild(s);
        }

        const allBtns = document.querySelectorAll("#brat-playbar-btn");
        if (allBtns.length > 1) {
            for (let i = 1; i < allBtns.length; i++) allBtns[i].remove();
        }
        if (allBtns.length >= 1 && document.body.contains(allBtns[0])) {
            allBtns[0].classList.toggle("is-active", store.state.isOpen);
            return;
        }

        const anchor = document.querySelector(
            '[data-testid="lyrics-button"], [data-testid="control-button-npv"], [data-testid="control-button-queue"]'
        );
        const container =
            anchor?.parentElement ||
            document.querySelector(".main-nowPlayingBar-extraControls, .ExtraControls");
        if (!container) return;

        const btn = document.createElement("button");
        btn.id = "brat-playbar-btn";
        btn.type = "button";
        btn.title = "Brat Lyrics (Alt + B)";
        btn.innerHTML = `
            <svg viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg">
                <rect x="1.5" y="1.5" width="15" height="15" rx="3" fill="#8ace00" stroke="#000000" stroke-width="1.2"/>
                <text x="9" y="13.2" text-anchor="middle" font-family="Arial, sans-serif" font-weight="900" font-size="12" fill="#000000">b</text>
            </svg>
        `;
        btn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            toggleOverlay();
        };

        if (anchor && container.contains(anchor)) {
            container.insertBefore(btn, anchor);
        } else {
            container.prepend(btn);
        }
    }

    mountSinglePlaybarButton();
    const intervalId = setInterval(mountSinglePlaybarButton, 1000);

    setTimeout(() => {
        checkUpdate();
    }, 2500);

    const onKeyDown = (e) => {
        if (e.altKey && (e.code === "KeyB" || e.key === "b" || e.key === "B")) {
            e.preventDefault();
            e.stopPropagation();
            toggleOverlay();
        } else if (e.key === "Escape" && store.state.isOpen && !document.fullscreenElement) {
            store.setState({ isOpen: false });
        }
    };
    window.addEventListener("keydown", onKeyDown, true);

    const onSongChange = () => {
        if (store.state.isOpen) loadLyricsForCurrentSong();
    };
    Spicetify.Player.addEventListener("songchange", onSongChange);

    store.subscribe((state, partial) => {
        renderer.overlay.classList.toggle("is-open", state.isOpen);
        renderer.syncColors(state.bgColor, state.textColor);

        const btn = document.getElementById("brat-playbar-btn");
        if (btn) btn.classList.toggle("is-active", state.isOpen);

        if (state.isOpen) {
            syncEngine.start();
        } else {
            syncEngine.stop();
        }

        if (
            partial &&
            ("displayMode" in partial || "transitionStyle" in partial) &&
            state.isOpen &&
            state.status === "ready" &&
            renderer.currentLine
        ) {
            renderer.renderLyricStage(
                renderer.currentLine,
                Math.max(0, renderer.currentWordIdx),
                true
            );
        }
    });

    window.__BRAT_LYRICS_CLEANUP__ = () => {
        clearInterval(intervalId);
        syncEngine.stop();
        window.removeEventListener("keydown", onKeyDown, true);
        Spicetify.Player.removeEventListener("songchange", onSongChange);
        document.querySelectorAll("#brat-playbar-btn").forEach((b) => b.remove());
        renderer.overlay?.remove();
    };
})();
