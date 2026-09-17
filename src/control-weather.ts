/** Current conditions for the control panel. No location is persisted to disk. */
export interface ControlWeatherRequest {
  query?: string;
  latitude?: number;
  longitude?: number;
}

export interface ControlWeather {
  status: "ready" | "stale" | "unavailable" | "needs-location";
  place: string | null;
  source: "timezone-estimate" | "search" | "device" | null;
  updatedAt: string | null;
  temperature: number | null;
  feelsLike: number | null;
  humidity: number | null;
  wind: number | null;
  condition: string | null;
  code: number | null;
  isDay: boolean | null;
  coordinates: { latitude: number; longitude: number } | null;
  timezone: string | null;
  units: { temperature: "°C"; wind: "km/h" };
  provider: "Open-Meteo";
  error?: string;
}

interface Location {
  place: string;
  source: NonNullable<ControlWeather["source"]>;
  coordinates: NonNullable<ControlWeather["coordinates"]>;
  timezone: string | null;
}

interface WeatherDependencies {
  fetch?: typeof fetch;
  now?: () => number;
  timezone?: () => string;
  timeoutMs?: number;
}

interface CacheEntry {
  result: ControlWeather;
  expiresAt: number;
  lastReady?: ControlWeather;
}

const FRESH_MS = 10 * 60_000;
const RETRY_MS = 60_000;
const STALE_MS = 3 * 60 * 60_000;
const CACHE_LIMIT = 24;

const emptyWeather = (error: string, status: ControlWeather["status"] = "unavailable"): ControlWeather => ({
  status, place: null, source: null, updatedAt: null, temperature: null,
  feelsLike: null, humidity: null, wind: null, condition: null, code: null,
  isDay: null, coordinates: null, timezone: null,
  units: { temperature: "°C", wind: "km/h" }, provider: "Open-Meteo", error,
});

function copyWeather(weather: ControlWeather): ControlWeather {
  return { ...weather, units: { ...weather.units }, coordinates: weather.coordinates ? { ...weather.coordinates } : null };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function numberIn(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max ? value : null;
}

function textValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 180) : null;
}

function canonicalTimezone(value: string): string | null {
  try { return new Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions().timeZone; }
  catch { return null; }
}

function describeWeather(code: number | null): string {
  if (code === 0) return "Clear sky";
  if (code === 1) return "Mainly clear";
  if (code === 2) return "Partly cloudy";
  if (code === 3) return "Overcast";
  if (code === 45 || code === 48) return "Fog";
  if (code === 51 || code === 53 || code === 55) return "Drizzle";
  if (code === 56 || code === 57) return "Freezing drizzle";
  if (code === 61 || code === 63 || code === 65) return "Rain";
  if (code === 66 || code === 67) return "Freezing rain";
  if (code === 71 || code === 73 || code === 75 || code === 77) return "Snow";
  if (code === 80 || code === 81 || code === 82) return "Rain showers";
  if (code === 85 || code === 86) return "Snow showers";
  if (code === 95) return "Thunderstorm";
  if (code === 96 || code === 99) return "Thunderstorm with hail";
  return "Unknown conditions";
}

/** Factory keeps the service testable without real network calls or Electron. */
export function createControlWeatherService(dependencies: WeatherDependencies = {}) {
  const fetchWeather = dependencies.fetch ?? globalThis.fetch;
  const now = dependencies.now ?? Date.now;
  const systemTimezone = dependencies.timezone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, Promise<ControlWeather>>();

  async function readJson(url: URL): Promise<Record<string, unknown>> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), dependencies.timeoutMs ?? 6_000);
    try {
      const response = await fetchWeather(url, { signal: abort.signal, headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error(`Weather service returned HTTP ${response.status}. Try again shortly.`);
      const data = record(await response.json());
      if (!data || data.error) throw new Error("The weather service returned an invalid response.");
      return data;
    } catch (error) {
      if (abort.signal.aborted) throw new Error("Weather request timed out. Check your connection and try again.");
      if (error instanceof Error && error.message.startsWith("Weather service returned HTTP")) throw error;
      if (error instanceof Error && error.message === "The weather service returned an invalid response.") throw error;
      throw new Error("Weather is unavailable. Check your connection and try again.");
    } finally {
      clearTimeout(timer);
    }
  }

  async function geocode(query: string, timezone: string | null): Promise<Location | null> {
    // https://open-meteo.com/en/docs/geocoding-api — names may include a country.
    const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
    url.search = new URLSearchParams({ name: query, count: "10", language: "en", format: "json" }).toString();
    const data = await readJson(url);
    const places = (Array.isArray(data.results) ? data.results : []).map(record).filter((place) => {
      return place && numberIn(place.latitude, -90, 90) !== null && numberIn(place.longitude, -180, 180) !== null && textValue(place.name);
    }) as Array<Record<string, unknown>>;
    // A timezone estimate must match its timezone, rather than a similarly named city elsewhere.
    const place = timezone ? places.find((candidate) => {
      const candidateTimezone = textValue(candidate.timezone);
      return candidateTimezone && canonicalTimezone(candidateTimezone) === canonicalTimezone(timezone);
    }) : places[0];
    if (!place) return null;
    const labels = [textValue(place.name), textValue(place.admin1), textValue(place.country)].filter((label): label is string => !!label);
    return {
      place: [...new Set(labels)].join(", "),
      source: timezone ? "timezone-estimate" : "search",
      coordinates: { latitude: place.latitude as number, longitude: place.longitude as number },
      timezone: textValue(place.timezone),
    };
  }

  async function currentConditions(location: Location): Promise<ControlWeather> {
    // https://open-meteo.com/en/docs — current values are weather-model conditions.
    const url = new URL("https://api.open-meteo.com/v1/forecast");
    url.search = new URLSearchParams({
      latitude: String(location.coordinates.latitude), longitude: String(location.coordinates.longitude),
      current: "temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code,is_day",
      temperature_unit: "celsius", wind_speed_unit: "kmh", timezone: "auto", timeformat: "unixtime", forecast_days: "1",
    }).toString();
    const data = await readJson(url);
    const current = record(data.current);
    const temperature = numberIn(current?.temperature_2m, -150, 100);
    const timestamp = numberIn(current?.time, 0, 10_000_000_000);
    if (!current || temperature === null || timestamp === null) throw new Error("Current weather data is missing. Try again shortly.");
    const observationAge = now() - timestamp * 1_000;
    if (observationAge > STALE_MS || observationAge < -60 * 60_000) throw new Error("The weather service has no recent conditions for this location.");
    const code = numberIn(current.weather_code, 0, 99);
    const stale = observationAge > 60 * 60_000;
    return {
      status: stale ? "stale" : "ready", ...location,
      timezone: textValue(data.timezone) ?? location.timezone,
      updatedAt: new Date(timestamp * 1_000).toISOString(), temperature,
      feelsLike: numberIn(current.apparent_temperature, -150, 100),
      humidity: numberIn(current.relative_humidity_2m, 0, 100),
      wind: numberIn(current.wind_speed_10m, 0, 500),
      code, condition: describeWeather(code), isDay: current.is_day === 1 ? true : current.is_day === 0 ? false : null,
      units: { temperature: "°C", wind: "km/h" }, provider: "Open-Meteo",
      ...(stale ? { error: "The latest available conditions are over an hour old." } : {}),
    };
  }

  return async function getWeather(request: ControlWeatherRequest = {}): Promise<ControlWeather> {
    if (!record(request)) return emptyWeather("Choose a city or share your device location.", "needs-location");
    let directLocation: Location | null = null;
    let query: string | null = null;
    let timezone: string | null = null;
    const hasCoordinates = request.latitude !== undefined || request.longitude !== undefined;
    if (hasCoordinates) {
      const latitude = numberIn(request.latitude, -90, 90);
      const longitude = numberIn(request.longitude, -180, 180);
      if (latitude === null || longitude === null) return emptyWeather("Device coordinates are invalid. Choose a city instead.", "needs-location");
      directLocation = { place: "Device location", source: "device", coordinates: { latitude, longitude }, timezone: null };
    } else if (request.query !== undefined) {
      if (typeof request.query !== "string" || request.query.trim().length < 2 || request.query.length > 120) {
        return emptyWeather("Enter a city name between 2 and 120 characters.", "needs-location");
      }
      query = request.query.trim();
    } else {
      try { timezone = systemTimezone(); } catch { /* A missing timezone is not a location. */ }
      if (!timezone || !canonicalTimezone(timezone) || /^(Etc\/|UTC$|GMT)/.test(timezone) || !timezone.includes("/")) {
        return emptyWeather("Choose a city or share your device location.", "needs-location");
      }
      query = timezone.split("/").at(-1)!.replace(/_/g, " ");
    }

    const key = directLocation ? `device:${directLocation.coordinates.latitude},${directLocation.coordinates.longitude}` : `${timezone ?? "search"}:${query!.toLowerCase()}`;
    const saved = cache.get(key);
    if (saved && saved.expiresAt > now()) return copyWeather(saved.result);
    const pending = inFlight.get(key);
    if (pending) return copyWeather(await pending);

    const work = (async (): Promise<ControlWeather> => {
      let location = directLocation;
      let result: ControlWeather;
      try {
        location ??= await geocode(query!, timezone);
        result = location ? await currentConditions(location) : emptyWeather(
          timezone ? "The timezone city could not be resolved. Choose your city." : "No matching city found. Try a city and country.",
          "needs-location",
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : "Weather is unavailable. Try again shortly.";
        const previous = saved?.lastReady;
        if (previous?.updatedAt && now() - Date.parse(previous.updatedAt) <= STALE_MS) {
          result = { ...previous, status: "stale", error: message };
        } else {
          result = { ...emptyWeather(message), ...(location ?? {}), ...(timezone && !location ? { source: "timezone-estimate" as const, timezone, place: query } : {}) };
        }
      }
      cache.delete(key);
      cache.set(key, {
        result, expiresAt: now() + (result.status === "ready" ? FRESH_MS : RETRY_MS),
        lastReady: result.status === "ready" || result.status === "stale" ? result : saved?.lastReady,
      });
      while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
      return result;
    })();
    inFlight.set(key, work);
    try { return copyWeather(await work); }
    finally { inFlight.delete(key); }
  };
}

export const getControlWeather = createControlWeatherService();
