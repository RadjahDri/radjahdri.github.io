/*
 * ThermalKing — portage JavaScript du moteur Python.
 *
 * Les règles de scoring sont identiques à la CLI :
 *   - lecture des enregistrements B des fichiers IGC ;
 *   - fusion des vols d'un même pilote ;
 *   - fenêtre demandée [début, fin[, puis fenêtre effective ;
 *   - échantillonnage seconde par seconde et gestion des égalités.
 *
 * Le fichier fonctionne à la fois comme script classique dans un navigateur
 * (window.ThermalKing) et comme module CommonJS pour les tests.
 */
(function (globalScope, factory) {
  "use strict";

  const api = factory();

  if (typeof module === "object" && module && module.exports) {
    module.exports = api;
  }
  if (globalScope) {
    globalScope.ThermalKing = api;
  }
})(
  typeof globalThis !== "undefined" ? globalThis : this,
  function () {
    "use strict";

    const SUPPORTED_ALTITUDES = ["gps", "pressure"];
    const TIE_POLICIES = ["all", "split"];
    const PILOT_TAGS = ["HFPLTPILOTINCHARGE:", "HFPLTPILOT:", "HFPLTNAME:"];
    const DEFAULT_MAX_GAP_SECONDS = 5;
    const DEFAULT_ALTITUDE_TOLERANCE = 1.0;
    const ONE_SECOND_MS = 1000;
    const ONE_DAY_MS = 86400000;

    // ---------------------------------------------------------------------
    // Dates et instants
    // ---------------------------------------------------------------------

    function padNumber(value, length) {
      return String(value).padStart(length || 2, "0");
    }

    function isLeapYear(year) {
      return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    }

    function daysInMonth(year, month) {
      if (month === 2) {
        return isLeapYear(year) ? 29 : 28;
      }
      return [4, 6, 9, 11].includes(month) ? 30 : 31;
    }

    function validDateParts(year, month, day) {
      return (
        Number.isInteger(year) &&
        Number.isInteger(month) &&
        Number.isInteger(day) &&
        month >= 1 &&
        month <= 12 &&
        day >= 1 &&
        day <= daysInMonth(year, month)
      );
    }

    function validTimeParts(hour, minute, second) {
      return (
        Number.isInteger(hour) &&
        Number.isInteger(minute) &&
        Number.isInteger(second) &&
        hour >= 0 &&
        hour <= 23 &&
        minute >= 0 &&
        minute <= 59 &&
        second >= 0 &&
        second <= 59
      );
    }

    /** Milliseconds since the Unix epoch for calendar fields interpreted as UTC. */
    function utcEpoch(year, month, day, hour, minute, second, millisecond) {
      const date = new Date(0);
      date.setUTCFullYear(year, month - 1, day);
      date.setUTCHours(hour || 0, minute || 0, second || 0, millisecond || 0);
      return date.getTime();
    }

    /**
     * An instant with the UTC offset it should be displayed with.
     * Python's aware datetimes keep their original offset in isoformat(); this
     * small wrapper does the same while comparisons use the absolute instant.
     */
    function makeMoment(milliseconds, offsetMinutes) {
      return {
        ms: milliseconds,
        offset: Number.isFinite(offsetMinutes) ? offsetMinutes : 0,
      };
    }

    function addSeconds(moment, seconds) {
      return makeMoment(moment.ms + seconds * ONE_SECOND_MS, moment.offset);
    }

    function minMoment(moments) {
      let best = moments[0];
      for (const current of moments) {
        if (current.ms < best.ms) {
          best = current;
        }
      }
      return best;
    }

    function maxMoment(moments) {
      let best = moments[0];
      for (const current of moments) {
        if (current.ms > best.ms) {
          best = current;
        }
      }
      return best;
    }

    function coerceMoment(value, name) {
      if (value === null || value === undefined) {
        return null;
      }
      if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) {
          throw new Error(name + ": date invalide");
        }
        return makeMoment(value.getTime(), 0);
      }
      if (typeof value === "object" && Number.isFinite(value.ms)) {
        return value;
      }
      throw new Error(name + ": date invalide");
    }

    const ISO_PATTERN =
      /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?([Zz]|[+-]\d{2}(?::?\d{2})?)$/;

    function parseIsoMoment(raw, name) {
      const text = String(raw).trim();
      const label = name || "date";

      if (!/(?:[Zz]|[+-]\d{2}(?::?\d{2})?)$/.test(text)) {
        throw new Error(
          label +
            ": la date " +
            JSON.stringify(text) +
            " doit inclure un decalage horaire (par exemple +02:00 ou Z)",
        );
      }

      const match = ISO_PATTERN.exec(text);
      if (!match) {
        throw new Error(label + ": date ISO 8601 invalide " + JSON.stringify(text));
      }

      const year = Number(match[1]);
      const month = Number(match[2]);
      const day = Number(match[3]);
      const hour = Number(match[4]);
      const minute = Number(match[5]);
      const second = match[6] === undefined ? 0 : Number(match[6]);
      const fraction = match[7] || "";
      const millisecond = Number((fraction + "000").slice(0, 3));
      const offsetText = match[8];

      if (!validDateParts(year, month, day) || !validTimeParts(hour, minute, second)) {
        throw new Error(label + ": date ISO 8601 invalide " + JSON.stringify(text));
      }

      let offsetMinutes = 0;
      if (!/^[Zz]$/.test(offsetText)) {
        const sign = offsetText[0] === "-" ? -1 : 1;
        const digits = offsetText.slice(1).replace(":", "");
        const offsetHours = Number(digits.slice(0, 2));
        const offsetMins = digits.length > 2 ? Number(digits.slice(2, 4)) : 0;
        if (offsetHours > 23 || offsetMins > 59) {
          throw new Error(label + ": date ISO 8601 invalide " + JSON.stringify(text));
        }
        offsetMinutes = sign * (offsetHours * 60 + offsetMins);
      }

      const epoch = utcEpoch(year, month, day, hour, minute, second, millisecond);
      return makeMoment(epoch - offsetMinutes * 60000, offsetMinutes);
    }

    /** Same shape as Python's datetime.isoformat() for aware datetimes. */
    function formatIso(moment) {
      const offset = moment.offset || 0;
      const shifted = new Date(moment.ms + offset * 60000);
      const year = shifted.getUTCFullYear();
      const month = shifted.getUTCMonth() + 1;
      const day = shifted.getUTCDate();
      const hour = shifted.getUTCHours();
      const minute = shifted.getUTCMinutes();
      const second = shifted.getUTCSeconds();
      const millisecond = shifted.getUTCMilliseconds();

      let text =
        padNumber(year, 4) +
        "-" +
        padNumber(month) +
        "-" +
        padNumber(day) +
        "T" +
        padNumber(hour) +
        ":" +
        padNumber(minute) +
        ":" +
        padNumber(second);

      if (millisecond !== 0) {
        text += "." + padNumber(millisecond * 1000, 6);
      }

      const sign = offset < 0 ? "-" : "+";
      const absolute = Math.abs(offset);
      return (
        text + sign + padNumber(Math.floor(absolute / 60)) + ":" + padNumber(absolute % 60)
      );
    }

    // ---------------------------------------------------------------------
    // Lecture IGC
    // ---------------------------------------------------------------------

    function splitLines(text) {
      return text.split(/\r\n|[\n\r\v\f\x1c-\x1e\x85\u2028\u2029]/);
    }

    function fileStem(fileName) {
      const base = String(fileName).split(/[\\/]/).pop() || "";
      const dot = base.lastIndexOf(".");
      return dot > 0 ? base.slice(0, dot) : base;
    }

    function parseHeaderDate(line, fileName) {
      const match = /(\d{6})/.exec(line);
      if (!match) {
        throw new Error(
          fileName + ": cannot parse the HFDTE date from " + JSON.stringify(line),
        );
      }
      const digits = match[1];
      const day = Number(digits.slice(0, 2));
      const month = Number(digits.slice(2, 4));
      const year = 2000 + Number(digits.slice(4, 6));
      if (!validDateParts(year, month, day)) {
        throw new Error(fileName + ": invalid HFDTE date " + JSON.stringify(digits));
      }
      return { year: year, month: month, day: day };
    }

    function parsePilot(line) {
      const upper = line.toUpperCase();
      for (const tag of PILOT_TAGS) {
        const index = upper.indexOf(tag);
        if (index >= 0) {
          const name = line.slice(index + tag.length).trim();
          return name || null;
        }
      }
      return null;
    }

    function parseCoordinate(raw, hemisphere, degreeDigits) {
      if (raw.length !== degreeDigits + 5 || !/^\d+$/.test(raw)) {
        return null;
      }
      const degrees = Number(raw.slice(0, degreeDigits));
      const minutes = Number(raw.slice(degreeDigits, degreeDigits + 2));
      const thousandths = Number(raw.slice(degreeDigits + 2));
      let value = degrees + minutes / 60 + thousandths / 1000 / 60;
      if (hemisphere.toUpperCase() === "S" || hemisphere.toUpperCase() === "W") {
        value = -value;
      }
      return value;
    }

    function addDays(dayParts, days) {
      const date = new Date(
        utcEpoch(dayParts.year, dayParts.month, dayParts.day, 0, 0, 0, 0) + days * ONE_DAY_MS,
      );
      return {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
      };
    }

    function parseBRecord(record, flight, altitude) {
      const hourRaw = record.slice(1, 3);
      const minuteRaw = record.slice(3, 5);
      const secondRaw = record.slice(5, 7);
      if (!/^\d{2}$/.test(hourRaw) || !/^\d{2}$/.test(minuteRaw) || !/^\d{2}$/.test(secondRaw)) {
        return null;
      }

      const hour = Number(hourRaw);
      const minute = Number(minuteRaw);
      const second = Number(secondRaw);
      const pressureRaw = record.slice(25, 30);
      const gpsRaw = record.slice(30, 35);

      const secondsOfDay = hour * 3600 + minute * 60 + second;
      if (secondsOfDay < flight.lastSeconds) {
        flight.dayOffset += 1; // vol passant minuit
      }
      flight.lastSeconds = secondsOfDay;

      const pressure = /^\d+$/.test(pressureRaw) ? Number(pressureRaw) : 0;
      const gps = /^\d+$/.test(gpsRaw) ? Number(gpsRaw) : 0;
      const value = altitude === "gps" ? gps || pressure : pressure || gps;
      if (value === 0) {
        return null; // 00000 = altitude indisponible en IGC
      }

      if (!validTimeParts(hour, minute, second)) {
        return null;
      }

      const day = addDays(flight.day, flight.dayOffset);
      const moment = makeMoment(
        utcEpoch(day.year, day.month, day.day, hour, minute, second, 0),
        0,
      );
      const latitude = parseCoordinate(record.slice(7, 14), record[14], 2);
      const longitude = parseCoordinate(record.slice(15, 23), record[23], 3);

      return {
        time: moment,
        altitude: Number(value),
        latitude: latitude,
        longitude: longitude,
      };
    }

    /**
     * Read one IGC document. Returns an array with a single Track, mirroring
     * the Python reader's API.
     */
    function readIgcText(text, fileName, altitude) {
      const source = altitude === undefined ? "gps" : altitude;
      if (!SUPPORTED_ALTITUDES.includes(source)) {
        throw new Error("unknown altitude source " + JSON.stringify(source));
      }

      const name = fileName || "trace.igc";
      const content = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
      let flight = null;
      let pilot = null;
      let day = null;

      for (const line of splitLines(content)) {
        const record = line.trim();
        if (!record) {
          continue;
        }
        const upper = record.toUpperCase();

        if (upper.startsWith("HFDTE")) {
          day = parseHeaderDate(record, name);
          continue;
        }
        if (upper.startsWith("HFPLT")) {
          pilot = parsePilot(record) || pilot;
          continue;
        }
        if (!upper.startsWith("B") || record.length < 35) {
          continue;
        }

        if (day === null) {
          throw new Error(name + ": B-record found before the HFDTE date header");
        }
        if (flight === null) {
          flight = {
            pilot: pilot || fileStem(name),
            day: day,
            samples: [],
            lastSeconds: -1,
            dayOffset: 0,
          };
        }

        const sample = parseBRecord(record, flight, source);
        if (sample !== null) {
          flight.samples.push(sample);
        }
      }

      if (flight === null || flight.samples.length === 0) {
        throw new Error(name + ": no usable B-record with an altitude found");
      }

      flight.pilot = pilot || fileStem(name);
      return [new Track(flight.pilot, flight.samples)];
    }

    /** Read `{name, text}` inputs and merge flights belonging to the same pilot. */
    function readTracks(inputs, options) {
      const settings = options || {};
      const altitude = settings.altitude === undefined ? "gps" : settings.altitude;
      if (!SUPPORTED_ALTITUDES.includes(altitude)) {
        throw new Error(
          "unknown altitude source " +
            JSON.stringify(altitude) +
            "; expected one of " +
            SUPPORTED_ALTITUDES.join(", "),
        );
      }

      const files = Array.from(inputs || []);
      if (files.length === 0) {
        throw new Error("no IGC file given");
      }

      const grouped = new Map();
      for (const file of files) {
        const tracks = readIgcText(file.text, file.name, altitude);
        for (const track of tracks) {
          if (grouped.has(track.pilot)) {
            grouped.get(track.pilot).push(...track.samples);
          } else {
            grouped.set(track.pilot, track.samples.slice());
          }
        }
      }

      const result = [];
      for (const [pilot, samples] of grouped) {
        result.push(new Track(pilot, samples));
      }
      return result;
    }

    // ---------------------------------------------------------------------
    // Modèle
    // ---------------------------------------------------------------------

    function compareStrings(left, right) {
      const leftPoints = Array.from(left);
      const rightPoints = Array.from(right);
      const length = Math.min(leftPoints.length, rightPoints.length);
      for (let index = 0; index < length; index += 1) {
        const leftCode = leftPoints[index].codePointAt(0);
        const rightCode = rightPoints[index].codePointAt(0);
        if (leftCode !== rightCode) {
          return leftCode - rightCode;
        }
      }
      return leftPoints.length - rightPoints.length;
    }

    function normaliseSamples(samples) {
      const ordered = Array.from(samples || []);
      ordered.sort((left, right) => left.time.ms - right.time.ms);
      const deduped = [];
      for (const sample of ordered) {
        if (deduped.length > 0 && deduped[deduped.length - 1].time.ms === sample.time.ms) {
          deduped[deduped.length - 1] = sample;
        } else {
          deduped.push(sample);
        }
      }
      return deduped;
    }

    function bisectRight(values, target) {
      let low = 0;
      let high = values.length;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (target < values[middle]) {
          high = middle;
        } else {
          low = middle + 1;
        }
      }
      return low;
    }

    class Track {
      constructor(pilot, samples) {
        this.pilot = String(pilot).trim();
        if (!this.pilot) {
          throw new Error("Track.pilot must be a non-empty name");
        }
        this.samples = normaliseSamples(samples);
        this._times = this.samples.map((sample) => sample.time.ms);
      }

      get firstTime() {
        return this.samples.length > 0 ? this.samples[0].time : null;
      }

      get lastTime() {
        return this.samples.length > 0 ? this.samples[this.samples.length - 1].time : null;
      }

      get length() {
        return this.samples.length;
      }

      altitudeAt(momentOrMilliseconds, maxGapMilliseconds) {
        const milliseconds =
          typeof momentOrMilliseconds === "number"
            ? momentOrMilliseconds
            : momentOrMilliseconds.ms;
        const index = bisectRight(this._times, milliseconds) - 1;
        if (index < 0) {
          return null;
        }
        const sample = this.samples[index];
        if (milliseconds - sample.time.ms > maxGapMilliseconds) {
          return null;
        }
        return sample.altitude;
      }
    }

    // ---------------------------------------------------------------------
    // Scoring
    // ---------------------------------------------------------------------

    function roundTo(value, digits) {
      // Python's round() uses round-half-to-even. Reproducing it matters here:
      // a share such as 1/128 s is exactly 0.0078125 and must become 0.007812,
      // not 0.007813 as Math.round() would do.
      const factor = Math.pow(10, digits);
      const scaled = value * factor;
      const lower = Math.floor(scaled);
      const fraction = scaled - lower;
      if (fraction > 0.5) {
        return (lower + 1) / factor;
      }
      if (fraction < 0.5) {
        return lower / factor;
      }
      return (lower % 2 === 0 ? lower : lower + 1) / factor;
    }

    function resolveBounds(pilots, start, end) {
      const firsts = pilots
        .map((track) => track.firstTime)
        .filter((moment) => moment !== null);
      const lasts = pilots.map((track) => track.lastTime).filter((moment) => moment !== null);

      let resolvedStart = coerceMoment(start, "start");
      let resolvedEnd = coerceMoment(end, "end");

      if (resolvedStart === null) {
        if (firsts.length === 0) {
          throw new Error(
            "start: aucun vol ne contient de point IGC pour deduire le debut de la fenetre",
          );
        }
        resolvedStart = minMoment(firsts);
      }
      if (resolvedEnd === null) {
        if (lasts.length === 0) {
          throw new Error(
            "end: aucun vol ne contient de point IGC pour deduire la fin de la fenetre",
          );
        }
        resolvedEnd = addSeconds(maxMoment(lasts), 1);
      }
      if (resolvedEnd.ms <= resolvedStart.ms) {
        throw new Error(
          "end (" +
            formatIso(resolvedEnd) +
            ") must be after start (" +
            formatIso(resolvedStart) +
            ")",
        );
      }
      return [resolvedStart, resolvedEnd];
    }

    function effectiveWindow(pilots, start, end) {
      const firsts = pilots
        .map((track) => track.firstTime)
        .filter((moment) => moment !== null);
      const lasts = pilots.map((track) => track.lastTime).filter((moment) => moment !== null);

      if (firsts.length === 0 || lasts.length === 0) {
        return [start, start];
      }

      const envelopeStart = minMoment(firsts);
      const envelopeEnd = addSeconds(maxMoment(lasts), 1);
      let effectiveStart = start.ms >= envelopeStart.ms ? start : envelopeStart;
      let effectiveEnd = end.ms <= envelopeEnd.ms ? end : envelopeEnd;

      if (effectiveEnd.ms < effectiveStart.ms) {
        const earlier = effectiveStart.ms <= end.ms ? effectiveStart : end;
        effectiveStart = earlier;
        effectiveEnd = earlier;
      }
      return [effectiveStart, effectiveEnd];
    }

    function scoreTracks(tracks, start, end, options) {
      const settings = options || {};
      const tiePolicy = settings.tiePolicy === undefined ? "all" : settings.tiePolicy;
      const maxGapSeconds =
        settings.maxGapSeconds === undefined
          ? DEFAULT_MAX_GAP_SECONDS
          : settings.maxGapSeconds;
      const altitudeTolerance =
        settings.altitudeTolerance === undefined
          ? DEFAULT_ALTITUDE_TOLERANCE
          : settings.altitudeTolerance;
      const withTimeline = settings.withTimeline === true;

      if (!TIE_POLICIES.includes(tiePolicy)) {
        throw new Error("unknown tie policy " + JSON.stringify(tiePolicy));
      }
      if (
        typeof maxGapSeconds !== "number" ||
        !Number.isFinite(maxGapSeconds) ||
        maxGapSeconds < 0
      ) {
        throw new Error("max_gap must be zero or positive");
      }

      const pilots = Array.from(tracks || []);
      if (pilots.length === 0) {
        throw new Error("at least one track is required");
      }

      const names = pilots.map((track) => track.pilot);
      const seen = new Set();
      const duplicates = new Set();
      for (const name of names) {
        if (seen.has(name)) {
          duplicates.add(name);
        }
        seen.add(name);
      }
      if (duplicates.size > 0) {
        throw new Error(
          "duplicate pilot name(s): " + Array.from(duplicates).sort(compareStrings).join(", "),
        );
      }

      const bounds = resolveBounds(pilots, start, end);
      const resolvedStart = bounds[0];
      const resolvedEnd = bounds[1];
      const windowBounds = effectiveWindow(pilots, resolvedStart, resolvedEnd);
      const effectiveStart = windowBounds[0];
      const effectiveEnd = windowBounds[1];
      const totalSeconds = Math.trunc((effectiveEnd.ms - effectiveStart.ms) / ONE_SECOND_MS);

      const points = new Map(names.map((name) => [name, 0]));
      const leadingSeconds = new Map(names.map((name) => [name, 0]));
      const maxGapMilliseconds = maxGapSeconds * ONE_SECOND_MS;
      let tiedSeconds = 0;
      const timeline = withTimeline ? [] : null;

      for (let offset = 0; offset < totalSeconds; offset += 1) {
        const moment = makeMoment(
          effectiveStart.ms + offset * ONE_SECOND_MS,
          effectiveStart.offset,
        );
        let bestAltitude = null;
        let leaders = [];

        for (const track of pilots) {
          const altitude = track.altitudeAt(moment, maxGapMilliseconds);
          if (altitude === null) {
            continue;
          }
          if (bestAltitude === null || altitude > bestAltitude + altitudeTolerance) {
            bestAltitude = altitude;
            leaders = [track.pilot];
          } else if (Math.abs(altitude - bestAltitude) <= altitudeTolerance) {
            leaders.push(track.pilot);
          }
        }

        if (leaders.length > 0) {
          if (leaders.length > 1) {
            tiedSeconds += 1;
          }
          for (const pilot of leaders) {
            leadingSeconds.set(pilot, leadingSeconds.get(pilot) + 1);
          }
          if (tiePolicy === "all") {
            for (const pilot of leaders) {
              points.set(pilot, points.get(pilot) + 1);
            }
          } else {
            const share = 1 / leaders.length;
            for (const pilot of leaders) {
              points.set(pilot, points.get(pilot) + share);
            }
          }
        }

        if (timeline !== null) {
          timeline.push({ time: moment, leaders: leaders.slice() });
        }
      }

      const scores = names.map((name) => ({
        pilot: name,
        points: roundTo(points.get(name), 6),
        leadingSeconds: leadingSeconds.get(name),
      }));
      scores.sort(
        (left, right) =>
          right.points - left.points ||
          right.leadingSeconds - left.leadingSeconds ||
          compareStrings(left.pilot, right.pilot),
      );

      return {
        start: resolvedStart,
        end: resolvedEnd,
        effectiveStart: effectiveStart,
        effectiveEnd: effectiveEnd,
        scores: scores,
        tiePolicy: tiePolicy,
        maxGapSeconds: maxGapSeconds,
        tiedSeconds: tiedSeconds,
        timeline: timeline,
      };
    }

    // ---------------------------------------------------------------------
    // Rapports
    // ---------------------------------------------------------------------

    function resultSeconds(result) {
      return Math.trunc((result.effectiveEnd.ms - result.effectiveStart.ms) / ONE_SECOND_MS);
    }

    function requestedSeconds(result) {
      return Math.trunc((result.end.ms - result.start.ms) / ONE_SECOND_MS);
    }

    function formatFixed(value, digits) {
      return roundTo(value, digits).toFixed(digits);
    }

    function formatPoints(points) {
      if (Math.abs(points - Math.round(points)) < 1e-9) {
        return String(Math.round(points));
      }
      return formatFixed(points, 3).replace(/0+$/, "").replace(/\.$/, "");
    }

    function formatDurationHms(seconds) {
      const value = Math.trunc(seconds);
      const hours = Math.floor(value / 3600);
      const minutes = Math.floor((value % 3600) / 60);
      const secs = value % 60;
      return padNumber(hours) + ":" + padNumber(minutes) + ":" + padNumber(secs);
    }

    function displayLength(value) {
      return Array.from(value).length;
    }

    function padDisplay(value, width, alignRight) {
      const padding = " ".repeat(Math.max(0, width - displayLength(value)));
      return alignRight ? padding + value : value + padding;
    }

    function formatTable(result) {
      const total = resultSeconds(result);
      const header = ["#", "Pilote", "Points", "Part du temps"];
      const rows = result.scores.map((score, index) => {
        const share = total > 0 ? (score.leadingSeconds / total) * 100 : 0;
        return [
          String(index + 1),
          score.pilot,
          formatPoints(score.points),
          formatFixed(share, 1) + " %",
        ];
      });

      const widths = header.map((value, column) =>
        Math.max(
          displayLength(value),
          ...rows.map((row) => displayLength(row[column])),
        ),
      );
      const rightAligned = new Set([0, 2, 3]);

      const render = (row) =>
        row
          .map((value, column) => padDisplay(value, widths[column], rightAligned.has(column)))
          .join("  ")
          .replace(/\s+$/, "");

      const separator = widths.map((width) => "-".repeat(width)).join("  ");
      const lines = [render(header), separator, ...rows.map((row) => render(row))];

      lines.push("");
      lines.push(
        "Fenetre demandee : " +
          formatIso(result.start) +
          " -> " +
          formatIso(result.end) +
          " (" +
          formatDurationHms(requestedSeconds(result)) +
          ")",
      );
      lines.push(
        "Fenetre effective : " +
          formatIso(result.effectiveStart) +
          " -> " +
          formatIso(result.effectiveEnd) +
          " (" +
          formatDurationHms(total) +
          ")",
      );
      lines.push(
        "Egalites : " +
          result.tiePolicy +
          ", trou max : " +
          Math.trunc(result.maxGapSeconds) +
          " s",
      );
      lines.push(
        "Secondes a egalite : " +
          result.tiedSeconds +
          " (plusieurs pilotes au sommet)",
      );
      if (total === 0) {
        lines.push(
          "Aucun pilote en vol dans la fenetre demandee : fenetre effective vide.",
        );
      }
      return lines.join("\n");
    }

    function toPayload(result, options) {
      const settings = options || {};
      const includeTimeline = settings.includeTimeline === true;
      const total = resultSeconds(result);

      const payload = {
        start: formatIso(result.start),
        end: formatIso(result.end),
        effective_start: formatIso(result.effectiveStart),
        effective_end: formatIso(result.effectiveEnd),
        requested_duration_seconds: requestedSeconds(result),
        duration_seconds: total,
        tie_policy: result.tiePolicy,
        max_gap_seconds: Math.trunc(result.maxGapSeconds),
        tied_seconds: result.tiedSeconds,
        leader: result.scores.length > 0 ? result.scores[0].pilot : null,
        scores: result.scores.map((score, index) => ({
          rank: index + 1,
          pilot: score.pilot,
          points: score.points,
          leading_seconds: score.leadingSeconds,
          share: total > 0 ? roundTo(score.leadingSeconds / total, 6) : 0.0,
        })),
      };

      if (includeTimeline && result.timeline !== null) {
        payload.timeline = result.timeline.map((entry) => ({
          time: formatIso(entry.time),
          leaders: entry.leaders.slice(),
        }));
      }
      return payload;
    }

    function toJson(result, options) {
      return JSON.stringify(toPayload(result, options), null, 2) + "\n";
    }

    function csvField(value) {
      const text = String(value);
      if (/[",\r\n]/.test(text)) {
        return '"' + text.replace(/"/g, '""') + '"';
      }
      return text;
    }

    function pythonFloat(value) {
      if (Object.is(value, -0)) {
        return "-0.0";
      }
      const text = String(value);
      return /[.eE]/.test(text) ? text : text + ".0";
    }

    function toCsv(result) {
      const total = resultSeconds(result);
      const lines = ["rank,pilot,points,share"];
      result.scores.forEach((score, index) => {
        const share = total > 0 ? roundTo(score.leadingSeconds / total, 6) : 0.0;
        lines.push(
          [
            index + 1,
            csvField(score.pilot),
            csvField(formatPoints(score.points)),
            csvField(pythonFloat(share)),
          ].join(","),
        );
      });
      return lines.join("\n") + "\n";
    }

    const api = {
      SUPPORTED_ALTITUDES: SUPPORTED_ALTITUDES,
      TIE_POLICIES: TIE_POLICIES,
      DEFAULT_MAX_GAP_SECONDS: DEFAULT_MAX_GAP_SECONDS,
      DEFAULT_ALTITUDE_TOLERANCE: DEFAULT_ALTITUDE_TOLERANCE,
      Track: Track,
      makeMoment: makeMoment,
      addSeconds: addSeconds,
      parseIsoMoment: parseIsoMoment,
      formatIso: formatIso,
      readIgcText: readIgcText,
      readTracks: readTracks,
      scoreTracks: scoreTracks,
      resultSeconds: resultSeconds,
      requestedSeconds: requestedSeconds,
      formatDurationHms: formatDurationHms,
      formatTable: formatTable,
      toPayload: toPayload,
      toJson: toJson,
      toCsv: toCsv,
      formatPoints: formatPoints,
      compareStrings: compareStrings,
    };

    // ---------------------------------------------------------------------
    // Interface navigateur
    // ---------------------------------------------------------------------

    function initUi() {
      if (typeof document === "undefined") {
        return;
      }
      const form = document.getElementById("score-form");
      if (!form) {
        return;
      }

      const fileInput = document.getElementById("file-input");
      const browseButton = document.getElementById("browse-button");
      const dropZone = document.getElementById("drop-zone");
      const fileList = document.getElementById("file-list");
      const fileEmpty = document.getElementById("file-empty");
      const runButton = document.getElementById("run-button");
      const resetButton = document.getElementById("reset-button");
      const startInput = document.getElementById("start");
      const endInput = document.getElementById("end");
      const tieInput = document.getElementById("tie");
      const maxGapInput = document.getElementById("max-gap");
      const altitudeInput = document.getElementById("altitude");
      const outputFormat = document.getElementById("output-format");
      const timelineInput = document.getElementById("timeline");
      const timelineWarning = document.getElementById("timeline-warning");
      const errorBox = document.getElementById("error");
      const results = document.getElementById("results");
      const resultsSubtitle = document.getElementById("results-subtitle");
      const rankingTable = document.getElementById("ranking-table");
      const rankingBody = document.getElementById("ranking-body");
      const rankingEmpty = document.getElementById("ranking-empty");
      const rankingCaption = document.getElementById("ranking-caption");
      const rawOutput = document.getElementById("raw-output");
      const rawFormatLabel = document.getElementById("raw-format-label");
      const output = document.getElementById("output");
      const copyButton = document.getElementById("copy-button");
      const downloadButton = document.getElementById("download-button");
      const summaryLeader = document.getElementById("summary-leader");
      const summaryPoints = document.getElementById("summary-points");
      const summaryDuration = document.getElementById("summary-duration");
      const summaryWindow = document.getElementById("summary-window");
      const summaryTied = document.getElementById("summary-tied");
      const summaryPolicy = document.getElementById("summary-policy");

      let selectedFiles = [];
      let nextFileId = 1;
      let currentOutput = { text: "", format: "table", fileName: "thermalking-classement.txt" };
      let busy = false;

      function formatBytes(bytes) {
        if (bytes < 1024) {
          return bytes + " o";
        }
        if (bytes < 1024 * 1024) {
          return (bytes / 1024).toFixed(1).replace(".0", "") + " Ko";
        }
        return (bytes / (1024 * 1024)).toFixed(1).replace(".0", "") + " Mo";
      }

      function setBusy(value) {
        busy = value;
        runButton.disabled = value;
        resetButton.disabled = value;
        runButton.classList.toggle("is-busy", value);
        const label = runButton.querySelector(".button-label");
        label.textContent = value ? "Calcul en cours…" : "Calculer le classement";
      }

      function showError(message) {
        errorBox.textContent = message;
        errorBox.hidden = false;
        errorBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
      }

      function clearError() {
        errorBox.hidden = true;
        errorBox.textContent = "";
      }

      function syncTimelineState() {
        const isJson = outputFormat.value === "json";
        timelineInput.disabled = !isJson;
        if (!isJson) {
          timelineInput.checked = false;
        }
        timelineWarning.hidden = true;
      }

      function renderFiles() {
        fileList.textContent = "";
        fileEmpty.hidden = selectedFiles.length > 0;

        selectedFiles.forEach((entry, index) => {
          const item = document.createElement("li");
          item.className = "file-item";

          const order = document.createElement("span");
          order.className = "file-order";
          order.textContent = String(index + 1);

          const details = document.createElement("span");
          details.className = "file-details";
          const name = document.createElement("span");
          name.className = "file-name";
          name.textContent = entry.file.name;
          const size = document.createElement("span");
          size.className = "file-size";
          size.textContent = formatBytes(entry.file.size);
          details.append(name, size);

          const actions = document.createElement("span");
          actions.className = "file-actions";

          function actionButton(label, title, handler, disabled) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "icon-button";
            button.textContent = label;
            button.title = title;
            button.setAttribute("aria-label", title);
            button.disabled = Boolean(disabled);
            button.addEventListener("click", handler);
            return button;
          }

          actions.append(actionButton("✕", "Retirer", () => removeFile(entry.id)));

          item.append(order, details, actions);
          fileList.append(item);
        });
      }

      function addFiles(fileCollection) {
        for (const file of Array.from(fileCollection)) {
          selectedFiles.push({ id: nextFileId, file: file });
          nextFileId += 1;
        }
        renderFiles();
      }

      function removeFile(id) {
        selectedFiles = selectedFiles.filter((entry) => entry.id !== id);
        renderFiles();
      }

      function parseMaxGap() {
        const raw = String(maxGapInput.value).trim().replace(",", ".");
        if (raw === "") {
          throw new Error("Trou maximal : indiquez une valeur en secondes.");
        }
        const value = Number(raw);
        if (!Number.isFinite(value) || value < 0) {
          throw new Error("Trou maximal : la valeur doit être un nombre positif ou nul.");
        }
        return value;
      }

      function outputFormatInfo(format) {
        if (format === "json") {
          return { mime: "application/json", extension: "json" };
        }
        if (format === "csv") {
          return { mime: "text/csv", extension: "csv" };
        }
        return { mime: "text/plain", extension: "txt" };
      }

      function outputFormatLabel(format) {
        if (format === "json") {
          return "JSON";
        }
        if (format === "csv") {
          return "CSV";
        }
        return "Tableau texte";
      }

      function tiePolicyLabel(policy) {
        if (policy === "split") {
          return "Point partagé";
        }
        return "Chacun marque un point";
      }

      function pilotInitials(name) {
        const parts = String(name).trim().split(/\s+/).filter(Boolean);
        if (parts.length === 0) {
          return "?";
        }
        if (parts.length === 1) {
          return Array.from(parts[0]).slice(0, 2).join("").toUpperCase();
        }
        return (
          Array.from(parts[0])[0] + Array.from(parts[parts.length - 1])[0]
        ).toUpperCase();
      }

      function renderRankingTable(result) {
        const total = resultSeconds(result);
        const scores = result.scores;
        const hasScores = scores.length > 0;
        const leaderPoints = hasScores ? scores[0].points : 0;

        rankingBody.textContent = "";
        rankingTable.hidden = !hasScores;
        rankingEmpty.hidden = hasScores;
        rankingCaption.textContent = hasScores
          ? "Trié par points puis temps en tête · durée scorée " + formatDurationHms(total)
          : "";

        scores.forEach((score, index) => {
          const rank = index + 1;
          const row = document.createElement("tr");
          if (rank === 1) {
            row.classList.add("is-winner");
          }
          if (rank <= 3) {
            row.classList.add("is-podium");
          }

          const rankCell = document.createElement("td");
          rankCell.className = "ranking-rank";
          const badge = document.createElement("span");
          badge.className = "rank-badge rank-" + rank;
          badge.textContent = String(rank);
          badge.setAttribute("aria-label", "Rang " + rank);
          rankCell.append(badge);

          const pilotCell = document.createElement("td");
          pilotCell.className = "ranking-pilot";
          const avatar = document.createElement("span");
          avatar.className = "pilot-avatar rank-" + rank;
          avatar.setAttribute("aria-hidden", "true");
          avatar.textContent = pilotInitials(score.pilot);
          const pilotText = document.createElement("span");
          pilotText.className = "pilot-text";
          const pilotName = document.createElement("span");
          pilotName.className = "pilot-name";
          pilotName.textContent = score.pilot;
          pilotText.append(pilotName);
          if (rank === 1) {
            const tag = document.createElement("span");
            tag.className = "pilot-tag";
            tag.textContent = "Vainqueur";
            pilotText.append(tag);
          } else if (Math.abs(score.points - leaderPoints) < 1e-9) {
            const tag = document.createElement("span");
            tag.className = "pilot-tag is-tied";
            tag.textContent = "À égalité";
            pilotText.append(tag);
          }
          const pilotWrap = document.createElement("div");
          pilotWrap.className = "pilot-cell";
          pilotWrap.append(avatar, pilotText);
          pilotCell.append(pilotWrap);

          const pointsCell = document.createElement("td");
          pointsCell.className = "ranking-points";
          const pointsValue = document.createElement("strong");
          pointsValue.textContent = formatPoints(score.points);
          const pointsUnit = document.createElement("span");
          pointsUnit.className = "points-unit";
          pointsUnit.textContent =
            "pt" + (Math.abs(score.points - 1) < 1e-9 ? "" : "s");
          pointsCell.append(pointsValue, document.createTextNode(" "), pointsUnit);

          const shareCell = document.createElement("td");
          shareCell.className = "ranking-share";
          const share = total > 0 ? (score.leadingSeconds / total) * 100 : 0;
          const barWidth = Math.max(0, Math.min(100, share));
          const shareWrap = document.createElement("div");
          shareWrap.className = "share";
          const track = document.createElement("span");
          track.className = "share-track";
          const fill = document.createElement("span");
          fill.className = "share-fill";
          fill.style.width = formatFixed(barWidth, 1) + "%";
          track.append(fill);
          const shareValue = document.createElement("span");
          shareValue.className = "share-value";
          shareValue.textContent = formatFixed(share, 1) + " %";
          shareWrap.append(track, shareValue);
          shareCell.append(shareWrap);

          row.append(rankCell, pilotCell, pointsCell, shareCell);
          rankingBody.append(row);
        });
      }

      function renderResults(result, format, includeTimeline) {
        const total = resultSeconds(result);
        const rendered =
          format === "json"
            ? toJson(result, { includeTimeline: includeTimeline })
            : format === "csv"
              ? toCsv(result)
              : formatTable(result) + "\n";

        const info = outputFormatInfo(format);
        currentOutput = {
          text: rendered,
          format: format,
          fileName: "thermalking-classement." + info.extension,
        };

        output.textContent = rendered;
        rawFormatLabel.textContent = outputFormatLabel(format);
        rawOutput.open = format !== "table";
        timelineWarning.hidden = !(includeTimeline && format !== "json");

        renderRankingTable(result);

        const leader = result.scores.length > 0 ? result.scores[0] : null;
        summaryLeader.textContent = leader ? leader.pilot : "—";
        summaryPoints.textContent = leader
          ? formatPoints(leader.points) +
            " point" +
            (Math.abs(leader.points - 1) < 1e-9 ? "" : "s")
          : "Aucun pilote";

        summaryDuration.textContent = formatDurationHms(total);
        summaryWindow.textContent =
          total === 0
            ? "Aucune seconde en vol"
            : formatIso(result.effectiveStart) + " → " + formatIso(result.effectiveEnd);

        summaryTied.textContent = String(result.tiedSeconds);
        summaryPolicy.textContent =
          tiePolicyLabel(result.tiePolicy) +
          " · tolérance " +
          (Number.isInteger(result.maxGapSeconds)
            ? result.maxGapSeconds
            : String(result.maxGapSeconds)) +
          " s";

        resultsSubtitle.textContent =
          result.scores.length +
          " pilote" +
          (result.scores.length === 1 ? "" : "s") +
          " · durée scorée : " +
          formatDurationHms(total);

        results.hidden = false;
        results.scrollIntoView({ behavior: "smooth", block: "start" });
      }

      async function copyOutput() {
        if (!currentOutput.text) {
          return;
        }
        try {
          await navigator.clipboard.writeText(currentOutput.text);
          copyButton.textContent = "Copié !";
        } catch (error) {
          const textarea = document.createElement("textarea");
          textarea.value = currentOutput.text;
          textarea.setAttribute("readonly", "");
          textarea.style.position = "fixed";
          textarea.style.opacity = "0";
          document.body.append(textarea);
          textarea.select();
          document.execCommand("copy");
          textarea.remove();
          copyButton.textContent = "Copié !";
        }
        window.setTimeout(() => {
          copyButton.textContent = "Copier";
        }, 1600);
      }

      function downloadOutput() {
        if (!currentOutput.text) {
          return;
        }
        const info = outputFormatInfo(currentOutput.format);
        const blob = new Blob([currentOutput.text], { type: info.mime + ";charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = currentOutput.fileName;
        document.body.append(link);
        link.click();
        link.remove();
        window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      }

      browseButton.addEventListener("click", () => fileInput.click());

      // Avoid the browser opening a dropped file when the drop misses the zone.
      window.addEventListener("dragover", (event) => event.preventDefault());
      window.addEventListener("drop", (event) => event.preventDefault());

      fileInput.addEventListener("change", () => {
        addFiles(fileInput.files);
        fileInput.value = "";
      });

      ["dragenter", "dragover"].forEach((eventName) => {
        dropZone.addEventListener(eventName, (event) => {
          event.preventDefault();
          dropZone.classList.add("is-dragging");
        });
      });

      ["dragleave", "dragend", "drop"].forEach((eventName) => {
        dropZone.addEventListener(eventName, (event) => {
          event.preventDefault();
          dropZone.classList.remove("is-dragging");
        });
      });

      dropZone.addEventListener("drop", (event) => {
        if (event.dataTransfer && event.dataTransfer.files) {
          addFiles(event.dataTransfer.files);
        }
      });

      dropZone.addEventListener("click", (event) => {
        if (!event.target.closest("button")) {
          fileInput.click();
        }
      });

      outputFormat.addEventListener("change", syncTimelineState);
      copyButton.addEventListener("click", copyOutput);
      downloadButton.addEventListener("click", downloadOutput);

      resetButton.addEventListener("click", () => {
        selectedFiles = [];
        form.reset();
        maxGapInput.value = "5";
        output.textContent = "";
        rankingBody.textContent = "";
        rankingCaption.textContent = "";
        rankingTable.hidden = false;
        rankingEmpty.hidden = true;
        rawOutput.open = false;
        rawFormatLabel.textContent = "Tableau texte";
        results.hidden = true;
        timelineWarning.hidden = true;
        currentOutput = { text: "", format: "table", fileName: "thermalking-classement.txt" };
        clearError();
        renderFiles();
        syncTimelineState();
        startInput.focus();
      });

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (busy) {
          return;
        }
        clearError();

        try {
          if (selectedFiles.length === 0) {
            throw new Error("Ajoutez au moins un fichier IGC avant de lancer le calcul.");
          }

          const start = startInput.value.trim()
            ? parseIsoMoment(startInput.value, "start")
            : null;
          const end = endInput.value.trim() ? parseIsoMoment(endInput.value, "end") : null;
          const maxGapSeconds = parseMaxGap();
          const format = outputFormat.value;
          const includeTimeline = format === "json" && timelineInput.checked;

          setBusy(true);
          await new Promise((resolve) => window.requestAnimationFrame(resolve));

          const contents = [];
          for (const entry of selectedFiles) {
            contents.push({ name: entry.file.name, text: await entry.file.text() });
          }

          const tracks = readTracks(contents, { altitude: altitudeInput.value });
          const result = scoreTracks(tracks, start, end, {
            tiePolicy: tieInput.value,
            maxGapSeconds: maxGapSeconds,
            withTimeline: includeTimeline,
          });

          renderResults(result, format, includeTimeline);
        } catch (error) {
          const message = error && error.message ? error.message : String(error);
          showError("Erreur : " + message);
          results.hidden = true;
        } finally {
          setBusy(false);
        }
      });

      renderFiles();
      syncTimelineState();
    }

    if (typeof document !== "undefined") {
      if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", initUi, { once: true });
      } else {
        initUi();
      }
    }

    return api;
  },
);
