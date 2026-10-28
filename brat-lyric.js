(function BratLyricsExtension() {
    const CURRENT_VERSION = "2.1.0";
    const UPDATE_CHECK_URL = "https://raw.githubusercontent.com/Kiano-Ksl/brat-lyrics-spicetify/main/version.json";
    const GITHUB_REPO_URL = "https://github.com/Kiano-Ksl/brat-lyrics-spicetify";
    const SPICY_API_URL = "https://api.spicylyrics.org/query";
    const SPICY_CLIENT_VERSION = "5.18.0";

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

        static expandMultiWordTokens(words) {
            if (!Array.isArray(words) || words.length === 0) return [];
            const expanded = [];
            for (const w of words) {
                const text = this.cleanText(w?.text || "");
                if (!text) continue;
                const parts = text.split(" ").filter(Boolean);
                if (parts.length <= 1) {
                    expanded.push({
                        text,
                        startTime: Number(w.startTime || 0),
                        endTime: Number(w.endTime || (w.startTime || 0) + 0.25)
                    });
                } else {
                    const splitItems = this.fallbackSplitWords(
                        text,
                        Number(w.startTime || 0),
                        Math.max(Number(w.startTime || 0) + 0.35, Number(w.endTime || 0))
                    );
                    expanded.push(...splitItems);
                }
            }
            return expanded;
        }

        static unwrapSpicyPayload(rawPayload, depth = 0) {
            if (!rawPayload || depth > 7) return null;

            let data = rawPayload;
            if (typeof data === "string") {
                const trimmed = data.trim();
                if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
                    try {
                        data = JSON.parse(trimmed);
                    } catch (_) {
                        return null;
                    }
                } else {
                    return null;
                }
            }

            if (!data || typeof data !== "object") return null;

            if (
                Array.isArray(data.Content) ||
                Array.isArray(data.content) ||
                Array.isArray(data.Lines) ||
                Array.isArray(data.lines)
            ) {
                return data;
            }

            if (Array.isArray(data.jobs)) {
                for (const job of data.jobs) {
                    const unwrapped = this.unwrapSpicyPayload(
                        job?.result?.data ?? job?.result?.response ?? job?.result ?? job?.data,
                        depth + 1
                    );
                    if (unwrapped) return unwrapped;
                }
            }

            if (Array.isArray(data.queries)) {
                for (const q of data.queries) {
                    const unwrapped = this.unwrapSpicyPayload(
                        q?.result?.data ?? q?.result?.response ?? q?.result ?? q?.data,
                        depth + 1
                    );
                    if (unwrapped) return unwrapped;
                }
            }

            const nestedKeys = ["result", "data", "content", "value", "lyrics", "payload", "response", "body"];
            for (const key of nestedKeys) {
                if (data[key] !== undefined && data[key] !== null) {
                    const unwrapped = this.unwrapSpicyPayload(data[key], depth + 1);
                    if (unwrapped) return unwrapped;
                }
            }

            return null;
        }

        static extractSyllableWords(syllables, timeDivisor) {
            const words = [];
            let wordBuffer = "";
            let wordStart = null;
            let wordEnd = null;

            for (let s = 0; s < syllables.length; s++) {
                const syl = syllables[s];
                if (syl?.IsBackground || syl?.isBackground || syl?.background) continue;

                const rawSylText = String(syl?.Text ?? syl?.text ?? "");
                const sStart = Number(syl?.StartTime ?? syl?.startTime ?? syl?.time ?? 0) / timeDivisor;
                const sEndRaw = syl?.EndTime ?? syl?.endTime ?? syl?.endtime;
                const sDurRaw = syl?.Duration ?? syl?.duration;
                const sEnd =
                    sEndRaw !== undefined
                        ? Number(sEndRaw) / timeDivisor
                        : sDurRaw !== undefined
                        ? sStart + Number(sDurRaw) / timeDivisor
                        : sStart + 0.2;

                const hasPartFlag =
                    syl?.IsPartOfWord !== undefined ||
                    syl?.isPartOfWord !== undefined ||
                    syl?.part !== undefined;
                const isPart = Boolean(syl?.IsPartOfWord ?? syl?.isPartOfWord ?? syl?.part);

                if (/^\s/.test(rawSylText) && wordBuffer) {
                    const cleanedPrev = this.cleanText(wordBuffer);
                    if (cleanedPrev) {
                        words.push({
                            text: cleanedPrev,
                            startTime: Number(wordStart.toFixed(3)),
                            endTime: Number(wordEnd.toFixed(3))
                        });
                    }
                    wordBuffer = "";
                    wordStart = null;
                }

                if (wordStart === null) wordStart = sStart;
                wordEnd = Math.max(sStart + 0.05, sEnd);
                wordBuffer += rawSylText.trim();

                const shouldFlush = hasPartFlag
                    ? !isPart || /\s$/.test(rawSylText) || s === syllables.length - 1
                    : /\s$/.test(rawSylText) || s === syllables.length - 1;

                if (shouldFlush) {
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
            return this.expandMultiWordTokens(words);
        }

        static fromSpicyLyricsJson(rawPayload, allowLineFallback = false) {
            const data = this.unwrapSpicyPayload(rawPayload);
            if (!data) return null;

            const syncType = String(data?.Type ?? data?.type ?? "").toLowerCase();
            const contentList = data?.Content || data?.content || data?.Lines || data?.lines;
            if (!Array.isArray(contentList) || contentList.length === 0) return null;

            let maxTimestamp = 0;
            for (const item of contentList) {
                const lead = item?.Lead || item?.lead || item;
                const syls =
                    lead?.Syllables ||
                    lead?.syllables ||
                    item?.Syllables ||
                    item?.syllables ||
                    (Array.isArray(lead) ? lead : null);
                const lastSylTime =
                    Array.isArray(syls) && syls.length > 0
                        ? Number(
                              syls[syls.length - 1]?.EndTime ??
                                  syls[syls.length - 1]?.endTime ??
                                  syls[0]?.StartTime ??
                                  0
                          )
                        : 0;
                const t = Math.max(
                    lastSylTime,
                    Number(lead?.EndTime ?? lead?.StartTime ?? item?.EndTime ?? item?.StartTime ?? 0)
                );
                if (t > maxTimestamp) maxTimestamp = t;
            }
            const timeDivisor = maxTimestamp > 1800 ? 1000 : 1;

            const hasSyllableStructure =
                syncType === "syllable" ||
                syncType === "word" ||
                contentList.some((c) => {
                    const l = c?.Lead || c?.lead || c;
                    const arr = l?.Syllables || l?.syllables || c?.Syllables || c?.syllables;
                    return Array.isArray(arr) && arr.length > 1;
                });

            if (hasSyllableStructure) {
                const lines = [];

                for (let i = 0; i < contentList.length; i++) {
                    const block = contentList[i];
                    const lead = block?.Lead || block?.lead || block;
                    let syllables =
                        lead?.Syllables ||
                        lead?.syllables ||
                        block?.Syllables ||
                        block?.syllables ||
                        (Array.isArray(lead) ? lead : null);

                    if ((!Array.isArray(syllables) || syllables.length === 0) && Array.isArray(block?.Background)) {
                        syllables = block.Background[0]?.Syllables || block.Background[0]?.syllables;
                    }
                    if (!Array.isArray(syllables) || syllables.length === 0) continue;

                    const words = this.extractSyllableWords(syllables, timeDivisor);
                    if (words.length > 0) {
                        lines.push({
                            startTime: words[0].startTime,
                            endTime: words[words.length - 1].endTime,
                            text: words.map((w) => w.text).join(" "),
                            words
                        });
                    }
                }

                if (lines.length > 0) {
                    return { lines, isWordSynced: true };
                }
            }

            if (allowLineFallback) {
                const lines = [];

                for (let i = 0; i < contentList.length; i++) {
                    const block = contentList[i];
                    const nextBlock = contentList[i + 1];
                    const lead = block?.Lead || block?.lead || block;
                    const rawText = String(
                        block?.Text ?? block?.text ?? lead?.Text ?? lead?.text ?? block?.Words ?? ""
                    );
                    const cleaned = this.cleanText(rawText);
                    if (!cleaned) continue;

                    const start =
                        Number(
                            block?.StartTime ??
                                block?.startTime ??
                                lead?.StartTime ??
                                lead?.startTime ??
                                0
                        ) / timeDivisor;
                    const endRaw =
                        Number(
                            block?.EndTime ?? block?.endTime ?? lead?.EndTime ?? lead?.endTime ?? 0
                        ) / timeDivisor;
                    const nextStart = nextBlock
                        ? Number(
                              nextBlock?.StartTime ??
                                  nextBlock?.startTime ??
                                  nextBlock?.Lead?.StartTime ??
                                  start + 3.5
                          ) / timeDivisor
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

        static fromLyricsPlusJson(rawInput, allowLineFallback = false) {
            let data = rawInput;
            if (typeof data === "string") {
                try {
                    data = JSON.parse(data);
                } catch (_) {
                    return null;
                }
            }

            const rawLyrics = data?.lyrics || data?.data?.lyrics || (Array.isArray(data) ? data : null);
            if (!Array.isArray(rawLyrics) || rawLyrics.length === 0) return null;

            const isLineType = String(data?.type ?? data?.Type ?? "").toLowerCase() === "line";
            const multiWordLines = rawLyrics.filter((l) => {
                const txt = this.cleanText(l?.text || "");
                return txt.split(" ").filter(Boolean).length >= 3;
            });

            const hasSyllables =
                !isLineType &&
                (multiWordLines.length > 0
                    ? multiWordLines.some((l) => {
                          const sylArr = l?.syllabus || l?.syllables || l?.words;
                          return Array.isArray(sylArr) && sylArr.length >= 3;
                      })
                    : rawLyrics.some((l) => {
                          const sylArr = l?.syllabus || l?.syllables || l?.words;
                          return Array.isArray(sylArr) && sylArr.length > 1;
                      }));

            if (!hasSyllables && !allowLineFallback) {
                return null;
            }

            let maxTime = 0;
            for (const l of rawLyrics) {
                const t = Number(l?.time ?? l?.startTime ?? 0);
                if (t > maxTime) maxTime = t;
            }
            const divisor = maxTime > 1800 ? 1000 : 1;

            const lines = [];

            for (let i = 0; i < rawLyrics.length; i++) {
                const line = rawLyrics[i];
                const nextLine = rawLyrics[i + 1];

                const lineStart = Number(line.time ?? line.startTime ?? 0) / divisor;
                const lineDur = Number(line.duration ?? 0) / divisor;
                const lineEnd =
                    lineDur > 0
                        ? lineStart + lineDur
                        : nextLine
                        ? Number(nextLine.time ?? nextLine.startTime ?? (lineStart + 3.5) * divisor) / divisor
                        : lineStart + 3.5;

                const sylList = line.syllabus || line.syllables || line.words;
                let words = [];

                if (hasSyllables && Array.isArray(sylList) && sylList.length > 0) {
                    let wordBuffer = "";
                    let wordStart = null;
                    let wordEnd = null;

                    const allHaveNoSpaces = sylList.every(
                        (s) => !/\s/.test(String(s?.text ?? s?.Text ?? "")) && s?.part === undefined
                    );

                    for (let s = 0; s < sylList.length; s++) {
                        const syl = sylList[s];
                        if (syl.isBackground || syl.background) continue;

                        const rawSyl = String(syl.text ?? syl.Text ?? "");
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

                        const sStart = Number(syl.time ?? syl.timestamp ?? syl.startTime ?? 0) / divisor;
                        const sDur = Number(syl.duration ?? 180) / divisor;
                        const sEnd =
                            syl.endtime !== undefined
                                ? Number(syl.endtime) / divisor
                                : syl.endTime !== undefined
                                ? Number(syl.endTime) / divisor
                                : sStart + (sDur > 0 ? sDur : 0.18);

                        if (wordStart === null) wordStart = sStart;
                        wordEnd = Math.max(sStart + 0.04, sEnd);
                        wordBuffer += rawSyl.trim();

                        const isEndOfWord =
                            allHaveNoSpaces ||
                            syl.part === false ||
                            endsWithSpace ||
                            s === sylList.length - 1;

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

                    words = this.expandMultiWordTokens(words);
                }

                const cleanedLine =
                    this.cleanText(line.text || "") || words.map((w) => w.text).join(" ");
                if (!cleanedLine) continue;

                if (words.length === 0) {
                    words = this.fallbackSplitWords(cleanedLine, lineStart, lineEnd);
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

            if (typeof ttmlXml !== "string" || (!ttmlXml.includes("<p") && !ttmlXml.includes("<tt:p"))) {
                return null;
            }

            const parser = new DOMParser();
            let doc = parser.parseFromString(ttmlXml, "text/xml");
            let pList = Array.from(doc.getElementsByTagName("p"));
            if (pList.length === 0) {
                pList = Array.from(doc.getElementsByTagName("tt:p"));
            }
            if (pList.length === 0) {
                doc = parser.parseFromString(ttmlXml, "text/html");
                pList = Array.from(doc.querySelectorAll("p, tt\\:p"));
            }
            if (pList.length === 0) return null;

            let hasMultiSpanLine = false;
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

                let words = [];
                const rawTimedSpans = [];
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

                            const childSpans = node.querySelectorAll("span, tt\\:span");
                            if (childSpans.length > 0) {
                                walkNodes(node);
                                continue;
                            }

                            const textVal = node.textContent || "";
                            if (b) {
                                const sStart = this.parseTime(b);
                                const sEnd = e ? this.parseTime(e) : sStart + 0.2;

                                const cleanToken = this.cleanText(textVal);
                                if (cleanToken) {
                                    rawTimedSpans.push({
                                        text: cleanToken,
                                        startTime: Number(sStart.toFixed(3)),
                                        endTime: Number(sEnd.toFixed(3))
                                    });
                                }

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

                if (rawTimedSpans.length > 1) {
                    hasMultiSpanLine = true;
                }

                if (words.length <= 1 && rawTimedSpans.length > 1) {
                    words = [...rawTimedSpans];
                }

                words = this.expandMultiWordTokens(words);

                const fullCleaned =
                    words.length > 0
                        ? words.map((w) => w.text).join(" ")
                        : this.cleanText(p.textContent || "");
                if (!fullCleaned) continue;

                if (words.length === 0) {
                    words = this.fallbackSplitWords(fullCleaned, lineStart, lineEnd);
                }

                lines.push({
                    startTime: words[0]?.startTime ?? lineStart,
                    endTime: words[words.length - 1]?.endTime ?? lineEnd,
                    text: words.map((w) => w.text).join(" "),
                    words
                });
            }

            if (!hasMultiSpanLine && !allowLineFallback) return null;
            return lines.length > 0 ? { lines, isWordSynced: hasMultiSpanLine } : null;
        }

        static fromPaxsenixJson(rawInput, allowLineFallback = false) {
            if (!rawInput) return null;

            let data = rawInput;
            if (typeof data === "string") {
                const trimmed = data.trim();
                if (trimmed.startsWith("<")) {
                    return this.fromTTML(trimmed, allowLineFallback);
                }
                try {
                    data = JSON.parse(trimmed);
                } catch (_) {
                    return null;
                }
            }

            if (typeof data?.ttml === "string" && (data.ttml.includes("<p") || data.ttml.includes("<tt:p"))) {
                return this.fromTTML(data.ttml, allowLineFallback);
            }
            if (typeof data?.lyrics === "string" && (data.lyrics.includes("<p") || data.lyrics.includes("<tt:p"))) {
                return this.fromTTML(data.lyrics, allowLineFallback);
            }

            const spicyAttempt = this.fromSpicyLyricsJson(data, allowLineFallback);
            if (spicyAttempt?.isWordSynced) return spicyAttempt;

            const rawArray = Array.isArray(data)
                ? data
                : Array.isArray(data.content)
                ? data.content
                : Array.isArray(data.lyrics)
                ? data.lyrics
                : Array.isArray(data.data)
                ? data.data
                : null;

            if (!rawArray || rawArray.length === 0) return null;

            if (rawArray.some((item) => Array.isArray(item.syllabus) || Array.isArray(item.syllables))) {
                return this.fromLyricsPlusJson({ lyrics: rawArray, type: data.type || "Word" }, allowLineFallback);
            }

            const lines = [];
            let hasWordTimings = false;

            for (let i = 0; i < rawArray.length; i++) {
                const item = rawArray[i];
                const lineStart = Number(item.timestamp ?? item.startTime ?? item.time ?? 0) / 1000;
                const lineEnd = Number(item.endtime ?? item.endTime ?? lineStart * 1000 + 3000) / 1000;

                if (Array.isArray(item.text) && item.text.length > 0) {
                    if (item.text.length > 1) hasWordTimings = true;
                    const words = this.extractSyllableWords(item.text, 1000);
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

            const rawLines = lrcText.split(/\r?\n/);
            const parsed = [];
            const lineTimeRgx = /\[(\d{1,2}):(\d{2}(?:\.\d{1,3})?)\]/;
            const wordTimeRgx = /<(\d{1,2}):(\d{2}(?:\.\d{1,3})?)>\s*([^<]*)/g;
            let hasELRC = false;

            for (const raw of rawLines) {
                const m = lineTimeRgx.exec(raw);
                const body = raw.replace(lineTimeRgx, "").trim();

                const eWords = [];
                wordTimeRgx.lastIndex = 0;
                let wm;
                while ((wm = wordTimeRgx.exec(body)) !== null) {
                    const wTime = parseInt(wm[1], 10) * 60 + parseFloat(wm[2]);
                    const wText = this.cleanText(wm[3]);
                    if (wText) eWords.push({ text: wText, startTime: wTime });
                }

                if (!m && eWords.length === 0) continue;

                const startTime = m
                    ? parseInt(m[1], 10) * 60 + parseFloat(m[2])
                    : eWords[0].startTime;

                if (eWords.length > 0) hasELRC = true;

                const plain = this.cleanText(body.replace(/<\d{1,2}:\d{2}(?:\.\d{1,3})?>/g, ""));
                if (plain || eWords.length > 0) {
                    parsed.push({
                        startTime,
                        plain: plain || eWords.map((w) => w.text).join(" "),
                        eWords
                    });
                }
            }

            if (!hasELRC && !allowLineFallback) return null;
            if (parsed.length === 0) return null;

            const lines = parsed.map((item, idx) => {
                const nextStart = parsed[idx + 1] ? parsed[idx + 1].startTime : item.startTime + 3.5;
                let words = [];

                if (item.eWords.length > 0) {
                    const rawMapped = item.eWords.map((w, wIdx) => ({
                        text: w.text,
                        startTime: w.startTime,
                        endTime: item.eWords[wIdx + 1] ? item.eWords[wIdx + 1].startTime : nextStart
                    }));
                    words = this.expandMultiWordTokens(rawMapped);
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
            const isSyllable =
                lyricsData?.syncType === "SYLLABLE_SYNCED" &&
                rawLines.some((l) => Array.isArray(l.syllables) && l.syllables.length > 1);
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
                    words = this.expandMultiWordTokens(words);
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

        static parseAnyPayload(rawInput, allowLineFallback = false) {
            if (!rawInput) return null;
            return (
                this.fromSpicyLyricsJson(rawInput, false) ||
                this.fromLyricsPlusJson(rawInput, false) ||
                this.fromTTML(rawInput, false) ||
                this.fromPaxsenixJson(rawInput, false) ||
                (allowLineFallback
                    ? this.fromSpicyLyricsJson(rawInput, true) ||
                      this.fromLyricsPlusJson(rawInput, true) ||
                      this.fromTTML(rawInput, true) ||
                      this.fromPaxsenixJson(rawInput, true)
                    : null)
            );
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
    let detectedSpicyVersion = SPICY_CLIENT_VERSION;

    function recordInterceptedPayload(rawPayload) {
        try {
            const currentUri = Spicetify.Player?.data?.item?.uri;
            if (!currentUri || !rawPayload) return;
            const parsed = BratLyricParser.parseAnyPayload(rawPayload, true);
            if (parsed && parsed.lines?.length > 0) {
                const existing = interceptedSpicyCache.get(currentUri);
                if (!existing || (!existing.isWordSynced && parsed.isWordSynced)) {
                    interceptedSpicyCache.set(currentUri, {
                        status: "ready",
                        lines: parsed.lines,
                        isWordSynced: Boolean(parsed.isWordSynced)
                    });
                }
            }
        } catch (_) {}
    }

    if (!window.__BRAT_NETWORK_HOOKED__) {
        window.__BRAT_NETWORK_HOOKED__ = true;

        const origFetch = window.fetch;
        window.fetch = async function (...args) {
            try {
                const headers = args[1]?.headers;
                if (headers && typeof headers === "object") {
                    const ver = headers["SpicyLyrics-Version"] || headers["spicylyrics-version"];
                    if (ver) detectedSpicyVersion = String(ver);
                }
            } catch (_) {}

            const response = await origFetch.apply(this, args);
            try {
                const url = String(args[0]?.url || args[0] || "");
                if (/spicylyrics|lyricsplus|paxsenix|binimum|color-lyrics|ttml/i.test(url)) {
                    response
                        .clone()
                        .text()
                        .then((txt) => recordInterceptedPayload(txt))
                        .catch(() => {});
                }
            } catch (_) {}
            return response;
        };

        const origResJson = Response.prototype.json;
        Response.prototype.json = async function () {
            const data = await origResJson.apply(this, arguments);
            try {
                if (this.url && /spicylyrics|lyricsplus|paxsenix|binimum|color-lyrics/i.test(this.url)) {
                    recordInterceptedPayload(data);
                }
            } catch (_) {}
            return data;
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
                "https://lyricsplus.binimum.org",
                "https://lyrics-plus-backend.vercel.app"
            ];
        }

        withTimeout(promise, ms = 4500) {
            return Promise.race([
                promise,
                new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), ms))
            ]);
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
                    const trackInfo = await this.withTimeout(
                        Spicetify.CosmosAsync.get(`https://api.spotify.com/v1/tracks/${trackId}`),
                        1400
                    );
                    if (trackInfo?.external_ids?.isrc) {
                        isrc = trackInfo.external_ids.isrc;
                    }
                } catch (_) {}
            }

            return { uri, trackId, title: cleanTitle || rawTitle, rawTitle, artist, album, durationSec, isrc };
        }

        async fetchTimeout(url, options = {}, signal, ms = 5500) {
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

        scanLocalWebStorage(trackId) {
            if (!trackId) return null;
            let fallbackLine = null;
            for (const storage of [window.localStorage, window.sessionStorage]) {
                try {
                    for (let i = 0; i < storage.length; i++) {
                        const key = storage.key(i) || "";
                        const val = storage.getItem(key) || "";
                        if (key.includes(trackId) || val.includes(trackId)) {
                            const parsed = BratLyricParser.parseAnyPayload(val, true);
                            if (parsed?.isWordSynced) return parsed;
                            if (parsed?.lines?.length > 0 && !fallbackLine) fallbackLine = parsed;
                        }
                    }
                } catch (_) {}
            }
            return fallbackLine;
        }

        async readInstalledSpicyLyricsCache(trackId) {
            if (!trackId) return null;

            const fromWebStorage = this.scanLocalWebStorage(trackId);
            if (fromWebStorage?.isWordSynced) return fromWebStorage;

            let bestFallback = fromWebStorage;

            if (window.caches) {
                try {
                    const cacheNames = await this.withTimeout(window.caches.keys(), 1000);
                    for (const cName of cacheNames) {
                        const cache = await window.caches.open(cName);
                        const requests = await cache.keys();
                        for (const req of requests) {
                            if (req.url.includes(trackId) || /spicylyrics|lyricsplus/i.test(req.url)) {
                                const match = await cache.match(req);
                                if (match) {
                                    const txt = await match.clone().text();
                                    if (txt.includes(trackId) || req.url.includes(trackId)) {
                                        const p = BratLyricParser.parseAnyPayload(txt, true);
                                        if (p?.isWordSynced) return p;
                                        if (p?.lines?.length > 0 && !bestFallback) bestFallback = p;
                                    }
                                }
                            }
                        }
                    }
                } catch (_) {}
            }

            if (!window.indexedDB) return bestFallback;

            try {
                const dbs =
                    (await this.withTimeout(window.indexedDB.databases?.() || Promise.resolve([]), 1200)) ||
                    [];
                for (const dbInfo of dbs) {
                    const dbName = dbInfo.name || "";
                    if (!dbName) continue;

                    const parsed = await this.withTimeout(
                        new Promise((resolve) => {
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
                                    let resolvedWord = null;
                                    let resolvedLine = null;

                                    storeNames.forEach((sName) => {
                                        const store = tx.objectStore(sName);
                                        const keysReq = store.getAllKeys();
                                        const valsReq = store.getAll();

                                        valsReq.onsuccess = () => {
                                            const keys = keysReq.result || [];
                                            const vals = valsReq.result || [];
                                            for (let idx = 0; idx < vals.length; idx++) {
                                                const kStr = String(keys[idx] ?? "");
                                                const entry = vals[idx];
                                                const vStr =
                                                    typeof entry === "string"
                                                        ? entry
                                                        : JSON.stringify(entry || "");

                                                if (kStr.includes(trackId) || vStr.includes(trackId)) {
                                                    const p = BratLyricParser.parseAnyPayload(entry, true);
                                                    if (p?.isWordSynced && !resolvedWord) {
                                                        resolvedWord = p;
                                                    } else if (p?.lines?.length > 0 && !resolvedLine) {
                                                        resolvedLine = p;
                                                    }
                                                }
                                            }
                                        };
                                    });

                                    tx.oncomplete = () => {
                                        db.close();
                                        resolve(resolvedWord || resolvedLine);
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
                        }),
                        1800
                    );

                    if (parsed?.isWordSynced) return parsed;
                    if (parsed?.lines?.length > 0 && !bestFallback) bestFallback = parsed;
                }
            } catch (_) {}

            return bestFallback;
        }

        async fetchLyrics() {
            if (this.abortController) this.abortController.abort();
            this.abortController = new AbortController();
            const { signal } = this.abortController;

            const meta = await this.extractRichTrackMeta();
            if (signal.aborted) return { status: "aborted" };
            if (!meta || (!meta.trackId && !meta.title)) {
                return { status: "no_track", lines: [], isWordSynced: false };
            }

            if (this.cache.has(meta.uri) && this.cache.get(meta.uri).isWordSynced) {
                return this.cache.get(meta.uri);
            }

            if (interceptedSpicyCache.has(meta.uri)) {
                const cached = interceptedSpicyCache.get(meta.uri);
                if (cached.isWordSynced) {
                    this.cache.set(meta.uri, cached);
                    return cached;
                }
            }

            let bestLineSyncedBackup = null;
            const saveLineBackup = (lines) => {
                if (!bestLineSyncedBackup && Array.isArray(lines) && lines.length > 0) {
                    bestLineSyncedBackup = { status: "ready", lines, isWordSynced: false };
                }
            };

            const wordSyncTasks = [];

            wordSyncTasks.push(
                (async () => {
                    const lrcParams = new URLSearchParams({
                        artist_name: meta.artist,
                        track_name: meta.title,
                        album_name: meta.album || meta.title
                    });
                    if (meta.durationSec > 0) lrcParams.set("duration", String(meta.durationSec));
                    const lrcRes = await this.fetchTimeout(
                        `https://lrclib.net/api/get?${lrcParams.toString()}`,
                        { cache: "no-store" },
                        signal,
                        5000
                    );
                    if (!lrcRes.ok) throw new Error();
                    const lrcJson = await lrcRes.json();

                    const eLrcParsed =
                        BratLyricParser.fromLRC(lrcJson?.syncedLyrics, false) ||
                        BratLyricParser.fromLRC(lrcJson?.plainLyrics, false);
                    if (eLrcParsed?.isWordSynced) {
                        return { status: "ready", lines: eLrcParsed.lines, isWordSynced: true };
                    }
                    const stdParsed = BratLyricParser.fromLRC(lrcJson?.syncedLyrics, true);
                    if (stdParsed) saveLineBackup(stdParsed.lines);
                    throw new Error();
                })()
            );

            wordSyncTasks.push(
                (async () => {
                    const searchParams = new URLSearchParams({
                        track_name: meta.title,
                        artist_name: meta.artist
                    });
                    const searchRes = await this.fetchTimeout(
                        `https://lrclib.net/api/search?${searchParams.toString()}`,
                        { cache: "no-store" },
                        signal,
                        5500
                    );
                    if (!searchRes.ok) throw new Error();
                    const list = await searchRes.json();
                    if (!Array.isArray(list) || list.length === 0) throw new Error();

                    for (const item of list) {
                        const eLrc =
                            BratLyricParser.fromLRC(item?.syncedLyrics, false) ||
                            BratLyricParser.fromLRC(item?.plainLyrics, false);
                        if (eLrc?.isWordSynced) {
                            return { status: "ready", lines: eLrc.lines, isWordSynced: true };
                        }
                    }

                    const firstSynced = list.find((item) => item?.syncedLyrics);
                    if (firstSynced?.syncedLyrics) {
                        const std = BratLyricParser.fromLRC(firstSynced.syncedLyrics, true);
                        if (std) saveLineBackup(std.lines);
                    }
                    throw new Error();
                })()
            );

            if (meta.trackId) {
                wordSyncTasks.push(
                    (async () => {
                        const localSpicy = await this.readInstalledSpicyLyricsCache(meta.trackId);
                        if (localSpicy?.isWordSynced) {
                            return { status: "ready", lines: localSpicy.lines, isWordSynced: true };
                        }
                        if (localSpicy?.lines?.length > 0) {
                            saveLineBackup(localSpicy.lines);
                        }
                        throw new Error();
                    })()
                );

                wordSyncTasks.push(
                    (async () => {
                        const payloads = [
                            {
                                jobs: [
                                    {
                                        handler: "lyrics",
                                        args: { id: meta.trackId, auth: "SpicyLyrics-WebAuth" }
                                    }
                                ],
                                client: { version: detectedSpicyVersion }
                            },
                            {
                                jobs: [{ handler: "lyrics", args: { id: meta.trackId } }],
                                client: { version: detectedSpicyVersion }
                            },
                            {
                                queries: [{ operation: "lyrics", variables: { id: meta.trackId } }],
                                client: { version: detectedSpicyVersion }
                            }
                        ];

                        for (const bodyObj of payloads) {
                            const res = await this.fetchTimeout(
                                SPICY_API_URL,
                                {
                                    method: "POST",
                                    headers: {
                                        "Content-Type": "application/json",
                                        "SpicyLyrics-Version": detectedSpicyVersion
                                    },
                                    body: JSON.stringify(bodyObj)
                                },
                                signal,
                                5000
                            );
                            if (!res.ok) continue;
                            const rawText = await res.text();
                            const wordParsed = BratLyricParser.parseAnyPayload(rawText, false);
                            if (wordParsed?.isWordSynced) {
                                return { status: "ready", lines: wordParsed.lines, isWordSynced: true };
                            }
                            const lineParsed = BratLyricParser.parseAnyPayload(rawText, true);
                            if (lineParsed?.lines?.length > 0) saveLineBackup(lineParsed.lines);
                        }
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
                        if (p?.isWordSynced) {
                            return { status: "ready", lines: p.lines, isWordSynced: true };
                        }
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
                            5500
                        );
                        if (!r.ok) throw new Error();
                        const rawText = await r.text();
                        const wordParsed = BratLyricParser.parseAnyPayload(rawText, false);
                        if (wordParsed?.isWordSynced) {
                            return { status: "ready", lines: wordParsed.lines, isWordSynced: true };
                        }
                        const lineParsed = BratLyricParser.parseAnyPayload(rawText, true);
                        if (lineParsed?.lines?.length > 0) saveLineBackup(lineParsed.lines);
                        throw new Error();
                    })()
                );
            }

            for (const countryCode of ["US", "GB", "ID"]) {
                wordSyncTasks.push(
                    (async () => {
                        const term = encodeURIComponent(`${meta.artist} ${meta.title}`);
                        const itunesRes = await this.fetchTimeout(
                            `https://itunes.apple.com/search?term=${term}&country=${countryCode}&entity=song&limit=10`,
                            {},
                            signal,
                            4500
                        );
                        if (!itunesRes.ok) throw new Error();
                        const itunesJson = await itunesRes.json();
                        const results = itunesJson?.results || [];
                        if (results.length === 0) throw new Error();

                        const targetArtist = meta.artist.toLowerCase();
                        const artistMatches = results.filter((item) => {
                            const aName = String(item.artistName || "").toLowerCase();
                            return aName.includes(targetArtist) || targetArtist.includes(aName);
                        });
                        const pool = artistMatches.length > 0 ? artistMatches : results;

                        let matchedSong = pool[0];
                        let bestDelta = Infinity;
                        for (const item of pool) {
                            const sec = Math.round((item.trackTimeMillis || 0) / 1000);
                            const delta = Math.abs(sec - meta.durationSec);
                            if (delta < bestDelta) {
                                bestDelta = delta;
                                matchedSong = item;
                            }
                        }

                        if (!matchedSong?.trackId) throw new Error();
                        const appleId = matchedSong.trackId;
                        const paxUrls = [
                            `https://lyrics.paxsenix.org/apple-music/lyrics?id=${appleId}&ttml=true&v=2`,
                            `https://lyrics.paxsenix.org/apple-music/lyrics?id=${appleId}`,
                            `https://api.paxsenix.org/lyrics/applemusic?id=${appleId}`
                        ];

                        for (const pUrl of paxUrls) {
                            try {
                                const paxRes = await this.fetchTimeout(pUrl, {}, signal, 4500);
                                if (!paxRes.ok) continue;
                                const textData = await paxRes.text();
                                const parsed = BratLyricParser.parseAnyPayload(textData, false);
                                if (parsed?.isWordSynced) {
                                    return { status: "ready", lines: parsed.lines, isWordSynced: true };
                                }
                            } catch (_) {}
                        }
                        throw new Error();
                    })()
                );
            }

            if (meta.trackId && Spicetify.CosmosAsync) {
                wordSyncTasks.push(
                    (async () => {
                        const spUrl = `https://spclient.wg.spotify.com/color-lyrics/v2/track/${meta.trackId}?format=json&vocalRemoval=false&market=from_token`;
                        const spRes = await this.withTimeout(Spicetify.CosmosAsync.get(spUrl), 3800);
                        if (!spRes?.lyrics) throw new Error();
                        const spWord = BratLyricParser.fromSpotify(spRes.lyrics, false);
                        if (spWord?.isWordSynced) {
                            return { status: "ready", lines: spWord.lines, isWordSynced: true };
                        }
                        if (spRes.lyrics.syncType === "LINE_SYNCED") {
                            const spLine = BratLyricParser.fromSpotify(spRes.lyrics, true);
                            if (spLine) saveLineBackup(spLine.lines);
                        }
                        throw new Error();
                    })()
                );
            }

            try {
                const fastestWordSync = await this.withTimeout(Promise.any(wordSyncTasks), 6500);
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

            return { status: "empty", lines: [], isWordSynced: false };
        }
    }

    class StateStore {
        constructor() {
            this.storageKey = "brat_lyrics_pure_v12";
            const saved = this.load();
            const validTransitions = ["rigid", "smooth", "slide"];
            const initialTransition = validTransitions.includes(saved.transitionStyle)
                ? saved.transitionStyle
                : "smooth";
            const prefMode = saved.preferredDisplayMode || saved.displayMode || "word_zoom";

            this.state = {
                isOpen: false,
                preferredDisplayMode: prefMode,
                displayMode: prefMode,
                hasNoWordSyncWarning: false,
                isCurrentSongWordSynced: true,
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
                        preferredDisplayMode: this.state.preferredDisplayMode,
                        displayMode: this.state.preferredDisplayMode,
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
                "preferredDisplayMode" in partial ||
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

    const MODE_LABELS = {
        word_zoom: "Word by Word (Auto-Zoom)",
        word_lock: "Word by Word (Locked Box)",
        full_line: "Full Sentence (Instant Square)"
    };

    class BratStageRenderer {
        constructor(store) {
            this.store = store;
            this.currentLine = null;
            this.currentWordIdx = -1;
            this.lockedWordSpans = [];
            this.linesUntilFlip = this.getRandomFlipCount();
            this.isModeDropdownOpen = false;

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
                    min-width: 345px;
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
                    width: 215px;
                }
                .brat-select option {
                    background: #141414;
                    color: #ffffff;
                }

                .brat-mode-dropdown {
                    position: relative;
                    width: 215px;
                    font-family: Arial, sans-serif;
                }
                .brat-mode-trigger {
                    width: 100%;
                    padding: 5px 24px 5px 8px;
                    border-radius: 6px;
                    border: 1.5px solid currentColor;
                    background: transparent;
                    color: inherit;
                    font-weight: bold;
                    font-size: 12px;
                    cursor: pointer;
                    outline: none;
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    text-align: left;
                    box-sizing: border-box;
                    position: relative;
                    white-space: nowrap;
                    overflow: hidden;
                    text-overflow: ellipsis;
                }
                .brat-mode-trigger.has-warning {
                    border-color: #3b82f6;
                }
                .brat-mode-arrow {
                    position: absolute;
                    right: 7px;
                    top: 50%;
                    transform: translateY(-50%);
                    font-size: 10px;
                    pointer-events: none;
                }
                .brat-top-badge {
                    position: absolute;
                    top: -7px;
                    right: -7px;
                    width: 18px;
                    height: 18px;
                    border-radius: 50%;
                    background: #2563eb;
                    color: #ffffff;
                    font-size: 11px;
                    font-weight: 900;
                    display: none;
                    align-items: center;
                    justify-content: center;
                    cursor: pointer;
                    box-shadow: 0 2px 8px rgba(37, 99, 235, 0.65);
                    border: 1.5px solid #ffffff;
                    z-index: 15;
                    line-height: 1;
                }
                .brat-top-badge.is-visible {
                    display: inline-flex;
                }
                .brat-mode-dropdown.is-open .brat-top-badge {
                    display: none !important;
                }

                .brat-mode-menu {
                    position: absolute;
                    top: calc(100% + 2px);
                    left: 0;
                    width: 100%;
                    background: #121212;
                    border: 1px solid #3f3f46;
                    border-radius: 4px;
                    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.55);
                    display: none;
                    flex-direction: column;
                    z-index: 30;
                    overflow: visible;
                }
                .brat-mode-dropdown.is-open .brat-mode-menu {
                    display: flex;
                }
                .brat-mode-option {
                    padding: 5px 8px;
                    font-size: 12px;
                    font-weight: 600;
                    color: #ffffff;
                    background: #121212;
                    cursor: pointer;
                    display: flex;
                    align-items: center;
                    justify-content: space-between;
                    gap: 6px;
                    position: relative;
                }
                .brat-mode-option:hover,
                .brat-mode-option.is-selected {
                    background: #93c5fd;
                    color: #000000;
                }
                .brat-option-badge {
                    width: 17px;
                    height: 17px;
                    min-width: 17px;
                    border-radius: 50%;
                    background: #2563eb;
                    color: #ffffff;
                    font-size: 11px;
                    font-weight: 900;
                    display: none;
                    align-items: center;
                    justify-content: center;
                    border: 1.5px solid #ffffff;
                    box-shadow: 0 1px 5px rgba(0, 0, 0, 0.4);
                    line-height: 1;
                    cursor: pointer;
                }
                .brat-option-badge.is-visible {
                    display: inline-flex;
                }

                .brat-fallback-tooltip {
                    position: absolute;
                    top: calc(100% + 8px);
                    right: 0;
                    width: 250px;
                    background: #111827;
                    color: #f9fafb;
                    border: 1.5px solid #3b82f6;
                    border-radius: 8px;
                    padding: 9px 11px;
                    font-size: 11.5px;
                    font-weight: 600;
                    line-height: 1.4;
                    box-shadow: 0 10px 25px rgba(0, 0, 0, 0.55);
                    display: none;
                    z-index: 45;
                    pointer-events: none;
                    text-align: left;
                }
                .brat-mode-dropdown.is-open .brat-fallback-tooltip {
                    top: calc(100% + 86px);
                }
                .brat-fallback-tooltip.is-visible {
                    display: block;
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

            this.modeDropdown = document.createElement("div");
            this.modeDropdown.className = "brat-mode-dropdown";

            this.modeTrigger = document.createElement("button");
            this.modeTrigger.type = "button";
            this.modeTrigger.className = "brat-mode-trigger";

            this.modeTriggerLabel = document.createElement("span");
            this.modeTriggerLabel.style.overflow = "hidden";
            this.modeTriggerLabel.style.textOverflow = "ellipsis";
            this.modeTriggerLabel.textContent = MODE_LABELS[displayMode] || MODE_LABELS.word_zoom;

            const arrowSpan = document.createElement("span");
            arrowSpan.className = "brat-mode-arrow";
            arrowSpan.textContent = "⌄";

            this.modeTrigger.append(this.modeTriggerLabel, arrowSpan);

            this.topFallbackBadge = document.createElement("span");
            this.topFallbackBadge.className = "brat-top-badge";
            this.topFallbackBadge.textContent = "!";

            this.modeMenu = document.createElement("div");
            this.modeMenu.className = "brat-mode-menu";

            this.modeOptionNodes = {};
            ["word_zoom", "word_lock", "full_line"].forEach((modeKey) => {
                const opt = document.createElement("div");
                opt.className = "brat-mode-option";
                opt.dataset.value = modeKey;

                const label = document.createElement("span");
                label.textContent = MODE_LABELS[modeKey];
                opt.appendChild(label);

                if (modeKey === "full_line") {
                    this.optionFallbackBadge = document.createElement("span");
                    this.optionFallbackBadge.className = "brat-option-badge";
                    this.optionFallbackBadge.textContent = "!";
                    opt.appendChild(this.optionFallbackBadge);
                }

                opt.onclick = (e) => {
                    e.stopPropagation();
                    this.selectModeOption(modeKey);
                };

                this.modeOptionNodes[modeKey] = opt;
                this.modeMenu.appendChild(opt);
            });

            this.fallbackTooltip = document.createElement("div");
            this.fallbackTooltip.className = "brat-fallback-tooltip";
            this.fallbackTooltip.textContent =
                "This song has no word-by-word sync data. Auto-switched to Full Sentence mode. You can still switch modes manually, and it will automatically return to Word by Word on supported songs.";

            this.modeDropdown.append(
                this.modeTrigger,
                this.topFallbackBadge,
                this.modeMenu,
                this.fallbackTooltip
            );
            rowMode.appendChild(this.modeDropdown);

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
            this.syncModeUI();
        }

        selectModeOption(chosenMode) {
            this.closeModeDropdown();
            this.store.setState({
                preferredDisplayMode: chosenMode,
                displayMode: chosenMode
            });
        }

        closeModeDropdown() {
            this.isModeDropdownOpen = false;
            this.modeDropdown.classList.remove("is-open");
            this.fallbackTooltip.classList.remove("is-visible");
        }

        bindEvents() {
            this.btnGear.onclick = () => {
                const open = this.panel.classList.toggle("is-open");
                this.hud.classList.toggle("is-pinned", open);
                if (!open) {
                    this.closeModeDropdown();
                }
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
                    this.closeModeDropdown();
                    this.store.setState({ isOpen: false });
                }
            };

            this.modeTrigger.onclick = (e) => {
                e.stopPropagation();
                this.isModeDropdownOpen = !this.isModeDropdownOpen;
                this.modeDropdown.classList.toggle("is-open", this.isModeDropdownOpen);
                this.fallbackTooltip.classList.remove("is-visible");
            };

            const showTooltip = () => {
                if (this.store.state.hasNoWordSyncWarning) {
                    this.fallbackTooltip.classList.add("is-visible");
                }
            };
            const hideTooltip = () => {
                this.fallbackTooltip.classList.remove("is-visible");
            };

            this.topFallbackBadge.addEventListener("mouseenter", showTooltip);
            this.topFallbackBadge.addEventListener("mouseleave", hideTooltip);
            this.topFallbackBadge.addEventListener("click", (e) => {
                e.stopPropagation();
                this.fallbackTooltip.classList.toggle("is-visible");
            });

            if (this.optionFallbackBadge) {
                this.optionFallbackBadge.addEventListener("mouseenter", showTooltip);
                this.optionFallbackBadge.addEventListener("mouseleave", hideTooltip);
                this.optionFallbackBadge.addEventListener("click", (e) => {
                    e.stopPropagation();
                    this.fallbackTooltip.classList.toggle("is-visible");
                });
            }

            this.overlay.addEventListener("click", () => {
                if (this.isModeDropdownOpen) {
                    this.closeModeDropdown();
                }
            });

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

        syncModeUI() {
            const { displayMode, hasNoWordSyncWarning } = this.store.state;
            this.modeTriggerLabel.textContent = MODE_LABELS[displayMode] || MODE_LABELS.word_zoom;
            this.modeTrigger.classList.toggle("has-warning", hasNoWordSyncWarning);
            this.topFallbackBadge.classList.toggle("is-visible", hasNoWordSyncWarning);

            if (this.optionFallbackBadge) {
                this.optionFallbackBadge.classList.toggle("is-visible", hasNoWordSyncWarning);
            }

            Object.keys(this.modeOptionNodes).forEach((key) => {
                this.modeOptionNodes[key].classList.toggle("is-selected", key === displayMode);
            });
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
            const effectiveWordCount = Math.max(
                wordCount,
                (this.box.textContent || "").trim().split(/\s+/).filter(Boolean).length
            );

            if (effectiveWordCount <= 1) {
                this.box.style.textAlign = "left";
                this.box.style.textAlignLast = "left";
            } else {
                this.box.style.textAlign = "justify";
                this.box.style.textAlignLast = justifyLastLine ? "justify" : "left";
            }

            const testFont = 100;
            this.box.style.fontSize = `${testFont}px`;

            this.box.style.whiteSpace = "nowrap";
            this.box.style.width = "max-content";
            const singleLineWidth = this.box.scrollWidth;
            const singleLineHeight = this.box.offsetHeight || testFont;

            this.box.style.whiteSpace = "normal";
            this.box.style.width = "10px";
            const minWordWidth = this.box.scrollWidth;

            let idealWidth = singleLineWidth;

            if (effectiveWordCount >= 2) {
                const areaSide = Math.sqrt(singleLineWidth * singleLineHeight * 1.18);
                const maxAllowedForFewWords =
                    effectiveWordCount === 2 ? singleLineWidth * 0.72 : singleLineWidth * 0.85;

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
            const maxFontCap = effectiveWordCount <= 2 ? 112 : 96;
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
            const hasWordSync = Boolean(res.isWordSynced);
            const pref = store.state.preferredDisplayMode;
            const shouldAutoFallback =
                !hasWordSync && (pref === "word_zoom" || pref === "word_lock");
            const activeMode = shouldAutoFallback ? "full_line" : pref;

            store.setState({
                status: "ready",
                lines: res.lines,
                isCurrentSongWordSynced: hasWordSync,
                displayMode: activeMode,
                hasNoWordSyncWarning: !hasWordSync
            });
            renderer.syncModeUI();
            syncEngine.tick(performance.now());
        } else if (res.status === "no_track") {
            store.setState({
                status: "no_track",
                lines: [],
                hasNoWordSyncWarning: false
            });
            renderer.syncModeUI();
            renderer.renderStatus("play a track first");
        } else {
            store.setState({
                status: "empty",
                lines: [],
                hasNoWordSyncWarning: false
            });
            renderer.syncModeUI();
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
        renderer.syncModeUI();

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
