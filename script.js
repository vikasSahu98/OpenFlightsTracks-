
// Map init
const map = L.map('map').setView([20.5937, 78.9629], 5);
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
}).addTo(map);

// ------------------------- Basemaps -------------------------
const baseLayers = {
    "OpenStreetMap": L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/">OSM</a>'
    }),

    "Carto Light": L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
        subdomains: "abcd",
        maxZoom: 20
    }),

    "Carto Dark": L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
        attribution: '&copy; <a href="https://www.openstreetmap.org/">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
        subdomains: "abcd",
        maxZoom: 20
    }),

    "Satellite (ESRI)": L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
        attribution: "Tiles © Esri &mdash; Source: Esri, Earthstar Geographics"
    })
};

// Set default base map
baseLayers["OpenStreetMap"].addTo(map);

// Add basemap control
L.control.layers(baseLayers, null, { position: "topright" }).addTo(map);

// ------------------------- Zoom control at bottom-left -------------------------
map.zoomControl.remove(); // remove default top-left zoom
L.control.scale({ position: "bottomright" }).addTo(map);
L.control.zoom({ position: "bottomright" }).addTo(map);


// Performance & state
let updateInterval = 3000; // ms
let maxFlightsToShow = 100;
let animationEnabled = true;
let intervalId = null;
let altitudeUnit = 'm'; // 'm' or 'ft'
let speedUnit = 'kmh';  // 'kmh' or 'kn'

// Storage: markers, tracks, raw data
const aircraftMarkers = {};   // icao24 -> L.marker
const aircraftTracks = {};    // icao24 -> L.polyline
const aircraftData = {};      // icao24 -> latest state

// FPS tracking
let lastFPSCheck = performance.now();
let frameCounter = 0;

// ------------------------- helpers ------------------------------
function showLoading() { document.getElementById('loading-indicator').style.display = 'block'; }
function hideLoading() { document.getElementById('loading-indicator').style.display = 'none'; }

function createAircraftIcon(category) {
    const className = `aircraft-icon ${category || ''}`;
    return L.divIcon({
        html: `<svg width="28" height="28" viewBox="0 0 24 24" class="${className}">
                                    <path fill="currentColor" d="M22 16v-2l-8.5-5V3.5c0-.83-.67-1.5-1.5-1.5S10.5 2.67 10.5 3.5V9L2 14v2l8.5-2.5V19L8 20.5V22l4-1 4 1v-1.5L13.5 19v-5.5L22 16z"/>
                                   </svg>`,
        className: 'aircraft-marker',
        iconSize: [28, 28],
        iconAnchor: [14, 14]
    });
}

// Apply rotation to svg inside marker element
function applyRotationToMarker(marker, angleDeg) {
    const el = marker.getElement();
    if (!el) return;
    const svg = el.querySelector('svg');
    if (!svg) return;
    svg.style.transformOrigin = '50% 50%';
    svg.style.transform = `rotate(${angleDeg}deg)`;
}

// ---------------------- simulated data generator -----------------
// This matches the format used earlier: { states: [ { icao24, latitude, longitude, velocity, trueTrack, ... }, ... ] }
function generateSimulatedFlightData() {
    const flights = {};
    const count = Math.min(maxFlightsToShow, 100 + Math.floor(Math.random() * 50));

    for (let i = 0; i < count; i++) {
        const icao24 = `abc${100 + Math.floor(Math.random() * 900)}`;

        if (aircraftData[icao24]) {
            const flight = aircraftData[icao24];
            const speed = Math.max(1, (flight.velocity || 200) + (Math.random() - 0.5) * 20); // m/s
            const bearing = (flight.trueTrack !== undefined ? flight.trueTrack : Math.random() * 360) + (Math.random() - 0.5) * 2;

            const distanceMeters = speed * (updateInterval / 1000);
            const bearingRad = bearing * Math.PI / 180;
            const lat = flight.latitude + (distanceMeters / 111320) * Math.cos(bearingRad);
            const lng = flight.longitude + (distanceMeters / (111320 * Math.cos(flight.latitude * Math.PI / 180))) * Math.sin(bearingRad);

            flights[icao24] = {
                ...flight,
                latitude: lat,
                longitude: lng,
                velocity: speed,
                trueTrack: (bearing + 360) % 360,
                lastUpdate: Date.now()
            };
        } else {
            const categories = ['commercial', 'private', 'cargo', 'military', 'general'];
            const category = categories[Math.floor(Math.random() * categories.length)];

            flights[icao24] = {
                icao24: icao24,
                callsign: `FLT${1000 + Math.floor(Math.random() * 9000)}`,
                originCountry: ['USA', 'GER', 'FRA', 'UK', 'JPN', 'AUS'][Math.floor(Math.random() * 6)],
                longitude: -180 + Math.random() * 360,
                latitude: -60 + Math.random() * 120,
                baroAltitude: Math.random() * 12000,
                velocity: 100 + Math.random() * 200, // m/s
                trueTrack: Math.random() * 360,
                verticalRate: -20 + Math.random() * 40,
                onGround: false,
                category: category,
                positionSource: Math.floor(Math.random() * 5),
                lastUpdate: Date.now()
            };
        }
    }

    return { states: Object.values(flights) };
}

// --------------------- process server data -----------------------
function processFlightData(data) {
    const viewFilter = document.getElementById('view-select').value;
    const sensorFilter = document.getElementById('sensor-select').value;
    const aircraftFilter = document.getElementById('aircraft-input').value.toUpperCase();

    let activeCount = 0;
    let visibleCount = 0;

    // Helper function to get the correct display strings based on current unit settings
    const getUnitStrings = (state) => {
        const altString = state.baroAltitude
            ? (altitudeUnit === 'ft'
                ? `${Math.round(state.baroAltitude * 3.28084)} ft`
                : `${Math.round(state.baroAltitude)} m`)
            : 'N/A';
        const speedString = state.velocity
            ? (speedUnit === 'kn'
                ? `${Math.round(state.velocity * 1.94384)} kn`
                : `${Math.round(state.velocity * 3.6)} km/h`)
            : 'N/A';
        return { altString, speedString };
    };
    if (data.states && Array.isArray(data.states)) {
        data.states.forEach(state => {
            const icao24 = state.icao24;
            aircraftData[icao24] = state;

            if (viewFilter === 'sensor' && sensorFilter !== '0' && state.positionSource != sensorFilter) {
                return;
            }

            if (viewFilter === 'aircraft' && aircraftFilter && !icao24.includes(aircraftFilter)) {
                return;
            }

            activeCount++;

            if (state.latitude !== undefined && state.longitude !== undefined) {
                visibleCount++;

                if (aircraftMarkers[icao24]) {
                    const marker = aircraftMarkers[icao24];

                    // Update predictive metadata (do NOT snap marker). We'll blend/predict in animation loop.
                    marker._state = state;
                    marker._speed = state.velocity || 0; // m/s
                    marker._track = (state.trueTrack !== undefined && state.trueTrack !== null) ? state.trueTrack : marker._track || 0;
                    marker._lastServerUpdate = Date.now();

                    // Rebase predicted anim position to current visual position to avoid sudden jumps
                    const currentLatLng = marker.getLatLng();
                    marker._animLat = currentLatLng.lat;
                    marker._animLng = currentLatLng.lng;
                    marker._animTime = performance.now();

                    const { altString, speedString } = getUnitStrings(state);

                    // update popup content
                    const popupContent = `\
                                            <strong>${state.callsign}</strong><br>\
                                            ICAO24: ${icao24}<br>\
                                            Country: ${state.originCountry}<br>\
                                            Type: ${state.category}<br>\
                                            Altitude: ${altString}<br>\
                                            Velocity: ${speedString}<br>\
                                            Track: ${state.trueTrack ? Math.round(state.trueTrack) + '°' : 'N/A'}`;

                    marker.getPopup() && marker.setPopupContent(popupContent);

                    // draw track polyline if enabled
                    if (window._tracksVisible && aircraftTracks[icao24]) {
                        const latlngs = aircraftTracks[icao24].getLatLngs();
                        latlngs.push([state.latitude, state.longitude]);
                        // keep track length reasonable
                        if (latlngs.length > 50) latlngs.shift();
                        aircraftTracks[icao24].setLatLngs(latlngs);
                    }

                } else {
                    // create marker for new flight
                    const marker = L.marker([state.latitude, state.longitude], {
                        icon: createAircraftIcon(state.category)
                    }).addTo(map);

                    // store predictive fields used by animation
                    marker._state = state;
                    marker._speed = state.velocity || 0;
                    marker._track = (state.trueTrack !== undefined && state.trueTrack !== null) ? state.trueTrack : 0;
                    marker._animLat = state.latitude;
                    marker._animLng = state.longitude;
                    marker._animTime = performance.now();
                    marker._lastServerUpdate = Date.now();

                    marker.on('add', () => applyRotationToMarker(marker, marker._track));

                    const { altString, speedString } = getUnitStrings(state);

                    const popupContent = `\
                                            <strong>${state.callsign}</strong><br>\
                                            ICAO24: ${icao24}<br>\
                                            Country: ${state.originCountry}<br>\
                                            Type: ${state.category}<br>\
                                            Altitude: ${altString}<br>\
                                            Velocity: ${speedString}<br>\
                                            Track: ${state.trueTrack ? Math.round(state.trueTrack) + '°' : 'N/A'}`;

                    marker.bindPopup(popupContent);

                    marker.on('click', () => {
                        const detailsElement = document.getElementById('aircraft-details');
                        // Re-calculate on click to ensure it uses the latest unit selection
                        const { altString: currentAltString, speedString: currentSpeedString } = getUnitStrings(state);
                        detailsElement.innerHTML = `\
                                                <strong>${state.callsign}</strong><br>\
                                                ICAO24: ${icao24}<br>\
                                                Country: ${state.originCountry}<br>\
                                                Type: ${state.category}<br>\
                                                Altitude: ${currentAltString}<br>\
                                                Velocity: ${currentSpeedString}<br>\
                                                Track: ${state.trueTrack ? Math.round(state.trueTrack) + '°' : 'N/A'}<br>\
                                                Vertical Rate: ${state.verticalRate ? Math.round(state.verticalRate) + ' m/s' : 'N/A'}<br>\
                                                On Ground: ${state.onGround ? 'Yes' : 'No'}`;
                    });

                    aircraftMarkers[icao24] = marker;

                    // create a track polyline (optional) and keep reference
                    if (window._tracksVisible) {
                        const poly = L.polyline([[state.latitude, state.longitude]], { weight: 2, opacity: 0.8 }).addTo(map);
                        aircraftTracks[icao24] = poly;
                    }
                }
            }
        });
    }

    // Remove markers for flights absent in aircraftData
    for (const icao in aircraftMarkers) {
        if (!aircraftData[icao]) {
            try { map.removeLayer(aircraftMarkers[icao]); } catch (e) { }
            delete aircraftMarkers[icao];

            if (aircraftTracks[icao]) {
                try { map.removeLayer(aircraftTracks[icao]); } catch (e) { }
                delete aircraftTracks[icao];
            }
        }
    }

    document.getElementById('active-flights').textContent = activeCount;
    document.getElementById('visible-flights').textContent = visibleCount;
    document.getElementById('last-update').textContent = new Date().toLocaleTimeString();
}

// ---------------------- continuous animation loop -----------------------
// Integrate movement for each marker every frame using speed (m/s) and track (deg). This prevents
// stuttering when server updates are sparse and keeps motion smooth.
function animationLoop(now) {
    frameCounter++;

    if (now - lastFPSCheck >= 1000) {
        document.getElementById('fps-counter').textContent = String(frameCounter);
        frameCounter = 0;
        lastFPSCheck = now;
    }

    if (animationEnabled) {
        const nowMs = now;
        for (const icao24 in aircraftMarkers) {
            const marker = aircraftMarkers[icao24];

            if (marker._animTime === undefined) {
                marker._animTime = nowMs;
                const ll = marker.getLatLng();
                marker._animLat = ll.lat;
                marker._animLng = ll.lng;
            }

            const dt = Math.min(0.5, (nowMs - (marker._animTime || nowMs)) / 1000);
            if (dt <= 0) continue;

            const speed = marker._speed || 0; // m/s
            const distanceMeters = speed * dt;
            const track = (marker._track !== undefined && marker._track !== null) ? marker._track : 0;
            const bearingRad = (track * Math.PI) / 180;

            const latRad = (marker._animLat * Math.PI) / 180 || 0;
            const deltaLatDeg = (distanceMeters / 111320) * Math.cos(bearingRad);
            const deltaLngDeg = (distanceMeters / (111320 * Math.max(0.0001, Math.cos(latRad)))) * Math.sin(bearingRad);

            marker._animLat = marker._animLat + deltaLatDeg;
            marker._animLng = marker._animLng + deltaLngDeg;
            marker._animTime = nowMs;

            try { marker.setLatLng([marker._animLat, marker._animLng]); } catch (e) { }

            applyRotationToMarker(marker, track);
        }
    }

    requestAnimationFrame(animationLoop);
}

// ---------------------- data fetch / scheduling -----------------------
async function fetchFlightData() {
    if (!animationEnabled) return;
    showLoading();
    try {
        // Replace this with real API call if you have credentials/rate limits handled
        const simulated = generateSimulatedFlightData();
        processFlightData(simulated);
    } catch (err) {
        console.error('Error fetching data', err);
    } finally {
        hideLoading();
    }
}

// async function fetchFlightData() {
//     if (!animationEnabled) return;
//     showLoading();
//     try {
//         const response = await fetch("https://opensky-network.org/api/states/all");
//         const json = await response.json();

//         // Convert OpenSky array format into your object format
//         const states = (json.states || []).map(s => ({
//             icao24: s[0],
//             callsign: s[1] ? s[1].trim() : "N/A",
//             originCountry: s[2],
//             timePosition: s[3],
//             lastContact: s[4],
//             longitude: s[5],
//             latitude: s[6],
//             baroAltitude: s[7],
//             onGround: s[8],
//             velocity: s[9],
//             trueTrack: s[10],
//             verticalRate: s[11],
//             sensors: s[12],
//             geoAltitude: s[13],
//             squawk: s[14],
//             spi: s[15],
//             positionSource: s[16],
//             category: "commercial" // You can refine this mapping later
//         }));

//         processFlightData({ states });
//     } catch (err) {
//         console.error("Error fetching data", err);
//     } finally {
//         hideLoading();
//     }
// }


// ---------------------- UI event handlers -------------------------
document.getElementById('view-select').addEventListener('change', function () {
    const view = this.value;
    document.getElementById('sensor-group').style.display = view === 'sensor' ? 'block' : 'none';
    document.getElementById('aircraft-group').style.display = view === 'aircraft' ? 'block' : 'none';
    fetchFlightData();
});

document.getElementById('sensor-select').addEventListener('change', fetchFlightData);
document.getElementById('aircraft-input').addEventListener('keypress', function (e) { if (e.key === 'Enter') fetchFlightData(); });

document.getElementById('toggle-tracks').addEventListener('click', function () {
    window._tracksVisible = !window._tracksVisible;
    this.innerHTML = window._tracksVisible ? '<i class="fas fa-route"></i> Hide Tracks' : '<i class="fas fa-route"></i> Show Tracks';

    // Add or remove polyline layers for existing markers
    if (window._tracksVisible) {
        for (const icao in aircraftMarkers) {
            if (!aircraftTracks[icao]) {
                const ll = aircraftMarkers[icao].getLatLng();
                const poly = L.polyline([[ll.lat, ll.lng]], { weight: 2, opacity: 0.8 }).addTo(map);
                aircraftTracks[icao] = poly;
            }
        }
    } else {
        for (const icao in aircraftTracks) {
            try { map.removeLayer(aircraftTracks[icao]); } catch (e) { }
            delete aircraftTracks[icao];
        }
    }
});

// ---------------------- Fullscreen Map -------------------------
document.getElementById('fullscreen-map').addEventListener('click', function () {
    const mapDiv = document.getElementById('map');
    if (!document.fullscreenElement) {
        if (mapDiv.requestFullscreen) {
            mapDiv.requestFullscreen();
        } else if (mapDiv.webkitRequestFullscreen) { /* Safari */
            mapDiv.webkitRequestFullscreen();
        } else if (mapDiv.msRequestFullscreen) { /* IE11 */
            mapDiv.msRequestFullscreen();
        }
    } else {
        if (document.exitFullscreen) {
            document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen();
        } else if (document.msExitFullscreen) {
            document.msExitFullscreen();
        }
    }
});

document.getElementById('update-data').addEventListener('click', fetchFlightData);

document.getElementById('reset-view').addEventListener('click', function () {
    map.setView([20.5937, 78.9629], 5);
    document.getElementById('view-select').value = 'all';
    document.getElementById('sensor-group').style.display = 'none';
    document.getElementById('aircraft-group').style.display = 'none';
    document.getElementById('aircraft-input').value = '';
    document.getElementById('aircraft-details').innerHTML = '';
    fetchFlightData();
});

document.getElementById('update-interval').addEventListener('input', function () {
    updateInterval = this.value * 1000;
    document.getElementById('interval-value').textContent = this.value + 's';
    clearInterval(intervalId);
    intervalId = setInterval(fetchFlightData, updateInterval);
});

document.getElementById('max-flights').addEventListener('input', function () {
    maxFlightsToShow = parseInt(this.value, 10);
    document.getElementById('max-flights-value').textContent = this.value;
});

document.getElementById('toggle-animation').addEventListener('click', function () {
    animationEnabled = !animationEnabled;
    this.innerHTML = animationEnabled ? '<i class="fas fa-pause"></i> Pause Animation' : '<i class="fas fa-play"></i> Resume Animation';
    if (animationEnabled) {
        clearInterval(intervalId);
        intervalId = setInterval(fetchFlightData, updateInterval);
        fetchFlightData();
    } else {
        clearInterval(intervalId);
    }
});

// Unit selection handlers
document.getElementById('altitude-unit-select').addEventListener('change', function () {
    altitudeUnit = this.value;
    // Re-process existing data to update all labels without a new fetch
    processFlightData({ states: Object.values(aircraftData) });
});

document.getElementById('speed-unit-select').addEventListener('change', function () {
    speedUnit = this.value;
    processFlightData({ states: Object.values(aircraftData) });
});

// Sidebar toggle functionality
document.getElementById('sidebar-toggle').addEventListener('click', function () {
    const sidebar = document.getElementById('sidebar');
    const isClosing = sidebar.classList.contains('closed');

    if (isClosing) {
        sidebar.classList.remove('closed');
        document.body.classList.remove('sidebar-closed');
        document.body.classList.add('sidebar-open');
        this.style.left = '335px';
        this.innerHTML = '<i class="fas fa-times"></i>';
    } else {
        sidebar.classList.add('closed');
        document.body.classList.remove('sidebar-open');
        document.body.classList.add('sidebar-closed');
        this.style.left = '15px';
        this.innerHTML = '<i class="fas fa-bars"></i>';
    }

    // Trigger map resize to ensure it renders correctly
    setTimeout(() => {
        map.invalidateSize();
    }, 300);
});

document.getElementById('sidebar-close').addEventListener('click', function () {
    document.getElementById('sidebar').classList.add('closed');
    document.body.classList.remove('sidebar-open');
    document.body.classList.add('sidebar-closed');
    document.getElementById('sidebar-toggle').style.left = '15px';
    document.getElementById('sidebar-toggle').innerHTML = '<i class="fas fa-bars"></i>';

    // Trigger map resize
    setTimeout(() => {
        map.invalidateSize();
    }, 300);
});

// Add map resize handler for window resize
window.addEventListener('resize', function () {
    setTimeout(() => {
        map.invalidateSize();
    }, 100);
});

// cleanup on unload
window.addEventListener('beforeunload', function () {
    clearInterval(intervalId);
});

// ---------------------- bootstrap -------------------------
window._tracksVisible = false;
intervalId = setInterval(fetchFlightData, updateInterval);
fetchFlightData();
requestAnimationFrame(animationLoop);

// Expose helpers for debugging from console
window._aircraftMarkers = aircraftMarkers;
window._aircraftData = aircraftData;
window._aircraftTracks = aircraftTracks;
