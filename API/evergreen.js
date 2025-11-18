// api/evergreen.js
// Vercel serverless function to fetch EvergreenHealth UC wait times from Epic,
// compute drive times from Redmond UC, and return clean JSON.

export default async function handler(req, res) {
  try {
    const EPIC_CSRF_TOKEN = process.env.EPIC_CSRF_TOKEN;
    const EPIC_COOKIE = process.env.EPIC_COOKIE;
    const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN;

    if (!EPIC_CSRF_TOKEN || !EPIC_COOKIE) {
      return res.status(500).json({ error: "EPIC_CSRF_TOKEN or EPIC_COOKIE not set" });
    }
    if (!MAPBOX_TOKEN) {
      return res.status(500).json({ error: "MAPBOX_TOKEN not set" });
    }

    const epicBase = "https://mychart.et1270.epichosted.com";
    const epicUrl = `${epicBase}/MyChart/Scheduling/OnMyWay/GetOnMyWayDepartmentData`;

    // Payload you captured from Firefox (JSON body)
    const payload = {
      rfvId: "WP-24rQmk-2FGC-2BmW8pnPncK1Fx9g-3D-3D-24r7f1gf3-2Fdj-2BI1LwPm5KN8-2FY2adj3CGabNn3sZBuaMJ0-3D",
      displayGroupIds: "",
      searchCoordinates:
        '{"ModelId":7,"_propertyListeners":[],"HasValue":true,"Coordinates":{"ModelId":388,"_propertyListeners":[]}}'
    };

    const epicRes = await fetch(epicUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "__RequestVerificationToken": EPIC_CSRF_TOKEN,
        "Cookie": EPIC_COOKIE,
        "Accept": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!epicRes.ok) {
      const text = await epicRes.text().catch(() => "");
      return res
        .status(502)
        .json({ error: "Epic API error", status: epicRes.status, body: text.slice(0, 500) });
    }

    const epicJson = await epicRes.json();

    // Epic typically uses OnMyWayDepartments; keep fallbacks in case of variation
    const departments =
      epicJson.OnMyWayDepartments ||
      epicJson.Departments ||
      epicJson.departmentList ||
      [];

    // Coordinates for each EvergreenHealth UC from your earlier snippet
    // and Redmond origin for drive-time calculations.
    const REDMOND_ORIGIN = {
      name: "EvergreenHealth Urgent Care, Redmond",
      lat: 47.6821696,
      lng: -122.1238347
    };

    const CLINIC_COORDS = {
      "EvergreenHealth Urgent Care, Canyon Park": {
        city: "Bothell, WA",
        lat: 47.8044871,
        lng: -122.2068921
      },
      "EvergreenHealth Urgent Care, Kenmore": {
        city: "Kenmore, WA",
        lat: 47.760574,
        lng: -122.2505451
      },
      "EvergreenHealth Urgent Care, Mill Creek": {
        city: "Mill Creek, WA",
        lat: 47.877566,
        lng: -122.1749333
      },
      "EvergreenHealth Urgent Care, Monroe": {
        city: "Monroe, WA",
        lat: 47.8628803,
        lng: -121.990223
      },
      "EvergreenHealth Urgent Care, Redmond": {
        city: "Redmond, WA",
        lat: REDMOND_ORIGIN.lat,
        lng: REDMOND_ORIGIN.lng
      },
      "EvergreenHealth Urgent Care, Totem Lake": {
        city: "Kirkland, WA",
        lat: 47.71393,
        lng: -122.1831048
      },
      "EvergreenHealth Urgent Care, Woodinville": {
        city: "Woodinville, WA",
        lat: 47.7543, // approximate if needed; update if you have exact
        lng: -122.1630
      }
      // Add Sammamish or others later if they join OnMyWay
    };

    function getMinutesEstimate(d) {
      // Epic often exposes WaitTime as a number of minutes
      const candidates = [
        d.WaitTime,
        d.WaitTimeInMinutes,
        d.DisplayWait,
        d.EstimatedWaitMinutes,
        d.EstWait
      ];
      for (const c of candidates) {
        const n = Number(c);
        if (Number.isFinite(n)) return n;
      }
      return null;
    }

    function getOpenStatus(d) {
      // Prefer explicit booleans if present
      if (typeof d.IsOpen === "boolean") return d.IsOpen;
      if (typeof d.IsOpenNow === "boolean") return d.IsOpenNow;

      // Fallback heuristic: treat as open if we have a wait time
      const mins = getMinutesEstimate(d);
      return mins !== null;
    }

    function getRangeString(d, minutes) {
      const candidates = [
        d.WaitTimeString,
        d.EstimatedWaitTimeText,
        d.DisplayWaitRange,
        d.WaitTimeText
      ].filter(Boolean);
      if (candidates.length > 0) {
        return String(candidates[0]);
      }
      if (!Number.isFinite(minutes)) return "n/a";

      // Build a 0.7x–1.3x range, rounded to nearest 5
      const min = Math.max(
        0,
        Math.round((minutes * 0.7) / 5) * 5
      );
      const max = Math.max(
        min,
        Math.round((minutes * 1.3) / 5) * 5
      );
      return `${min}–${max} min`;
    }

    async function getDriveTimeMiles(dest) {
      // Returns { minutes, miles } or null if it fails
      try {
        const url =
          `https://api.mapbox.com/directions/v5/mapbox/driving-traffic/` +
          `${REDMOND_ORIGIN.lng},${REDMOND_ORIGIN.lat};${dest.lng},${dest.lat}` +
          `?overview=false&access_token=${encodeURIComponent(MAPBOX_TOKEN)}`;

        const r = await fetch(url);
        if (!r.ok) return null;
        const data = await r.json();
        if (!data.routes || !data.routes[0]) return null;

        const route = data.routes[0];
        const minutes = Math.round(route.duration / 60);
        const miles = Math.round(route.distance * 0.000621371 * 10) / 10;
        return { minutes, miles };
      } catch {
        return null;
      }
    }

    // Map Epic departments into our clean structure
    const mapped = [];
    for (const d of departments) {
      const name = String(d.Name || d.DepartmentName || "").trim();
      if (!name) continue;

      const coords = CLINIC_COORDS[name];
      const minutes = getMinutesEstimate(d);
      const range = getRangeString(d, minutes);
      const isOpen = getOpenStatus(d);

      // Calculate drive only if we know coords
      let drive = null;
      if (coords) {
        drive = await getDriveTimeMiles(coords);
      }

      mapped.push({
        name,
        city: coords?.city || "",
        isOpen,
        minutes, // numeric estimate
        waitText: minutes != null ? `${minutes} min` : "n/a",
        range,
        driveMinutes: drive?.minutes ?? null,
        driveMiles: drive?.miles ?? null
      });
    }

    // Alphabetical sorting
    mapped.sort((a, b) => a.name.localeCompare(b.name));

    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({
      updatedAt: new Date().toISOString(),
      locations: mapped
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error", detail: String(err) });
  }
}
