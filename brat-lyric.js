// brat-lyric.js

var daftarLirik = [];
var layarBrat = null;
var teksBrat = null;
var statusLirik = "mencari"; 
var barisSaatIni = -1; 

function mulaiEkstensiBrat() {
    if (!Spicetify.Player || !Spicetify.Topbar) {
        setTimeout(mulaiEkstensiBrat, 1000);
        return;
    }

    layarBrat = document.createElement("div");
    layarBrat.style.position = "fixed";
    layarBrat.style.top = "0";
    layarBrat.style.left = "0";
    layarBrat.style.width = "100%";
    layarBrat.style.height = "100%";
    layarBrat.style.backgroundColor = "white"; 
    layarBrat.style.zIndex = "9999"; 
    layarBrat.style.display = "none";
    layarBrat.style.alignItems = "center";
    layarBrat.style.justifyContent = "center";
    layarBrat.style.padding = "20px";
    layarBrat.style.transition = "background-color 0.3s ease"; 

    teksBrat = document.createElement("div");
    teksBrat.style.fontFamily = "Arial, sans-serif";
    teksBrat.style.color = "black"; 
    teksBrat.style.fontWeight = "normal"; 
    teksBrat.style.textTransform = "lowercase";
    teksBrat.style.textAlign = "justify";
    teksBrat.style.textAlignLast = "justify";
    teksBrat.style.filter = "blur(1.5px)";
    teksBrat.style.wordBreak = "normal"; 
    teksBrat.style.overflowWrap = "normal";
    teksBrat.style.opacity = "0"; 
    teksBrat.style.transition = "color 0.3s ease, opacity 0.4s ease-in"; 

    layarBrat.appendChild(teksBrat);

    var wadahTombol = document.createElement("div");
    wadahTombol.style.position = "absolute";
    wadahTombol.style.top = "30px";
    wadahTombol.style.left = "50%";
    wadahTombol.style.transform = "translateX(-50%)"; 
    wadahTombol.style.display = "flex";
    wadahTombol.style.gap = "40px"; 
    wadahTombol.style.opacity = "0"; 
    wadahTombol.style.transition = "opacity 0.3s ease"; 
    wadahTombol.style.zIndex = "10001";
    
    // Panel Pengaturan
    var panelWarna = document.createElement("div");
    panelWarna.style.position = "absolute";
    panelWarna.style.top = "40px";
    panelWarna.style.left = "50%";
    panelWarna.style.transform = "translateX(-50%)";
    panelWarna.style.backgroundColor = "white";
    panelWarna.style.border = "2px solid black";
    panelWarna.style.borderRadius = "8px";
    panelWarna.style.padding = "15px";
    panelWarna.style.display = "none";
    panelWarna.style.flexDirection = "column";
    panelWarna.style.gap = "15px";
    panelWarna.style.fontFamily = "Arial, sans-serif";
    panelWarna.style.fontSize = "14px";
    panelWarna.style.fontWeight = "bold";
    panelWarna.style.color = "black";
    panelWarna.style.boxShadow = "0px 4px 10px rgba(0,0,0,0.2)";

    // Input Warna Background
    var barisBg = document.createElement("div");
    barisBg.style.display = "flex";
    barisBg.style.justifyContent = "space-between";
    barisBg.style.alignItems = "center";
    barisBg.style.gap = "20px";
    var labelBg = document.createElement("span");
    labelBg.innerText = "Background";
    var inputBg = document.createElement("input");
    inputBg.type = "color";
    inputBg.value = "#ffffff";
    inputBg.style.cursor = "pointer";
    barisBg.appendChild(labelBg);
    barisBg.appendChild(inputBg);

    // Input Warna Teks
    var barisTeks = document.createElement("div");
    barisTeks.style.display = "flex";
    barisTeks.style.justifyContent = "space-between";
    barisTeks.style.alignItems = "center";
    barisTeks.style.gap = "20px";
    var labelTeks = document.createElement("span");
    labelTeks.innerText = "Teks Lirik";
    var inputTeks = document.createElement("input");
    inputTeks.type = "color";
    inputTeks.value = "#000000";
    inputTeks.style.cursor = "pointer";
    barisTeks.appendChild(labelTeks);
    barisTeks.appendChild(inputTeks);

    panelWarna.appendChild(barisBg);
    panelWarna.appendChild(barisTeks);

    // Logika Perubahan Warna
    inputBg.addEventListener("input", function(e) {
        layarBrat.style.backgroundColor = e.target.value;
        panelWarna.style.backgroundColor = e.target.value;
    });

    inputTeks.addEventListener("input", function(e) {
        var warnaBaru = e.target.value;
        teksBrat.style.color = warnaBaru;
        tombolGear.style.color = warnaBaru;
        tombolFull.style.color = warnaBaru;
        tombolTutup.style.color = warnaBaru;
        panelWarna.style.color = warnaBaru;
        panelWarna.style.borderColor = warnaBaru;
    });

    var panelWarnaTerbuka = false;

    // --- Tombol Gear ---
    var tombolGear = document.createElement("div");
    tombolGear.innerText = "⚙"; 
    tombolGear.style.fontSize = "25px"; 
    tombolGear.style.fontWeight = "normal";
    tombolGear.style.fontFamily = "Arial, sans-serif";
    tombolGear.style.cursor = "pointer";
    tombolGear.style.color = "black";
    tombolGear.style.transition = "color 0.3s ease";
    
    tombolGear.onclick = function() {
        panelWarnaTerbuka = !panelWarnaTerbuka;
        if (panelWarnaTerbuka) {
            panelWarna.style.display = "flex";
            wadahTombol.style.opacity = "1"; // Kunci agar tombol gak ngilang
        } else {
            panelWarna.style.display = "none";
        }
    };

    // --- Tombol Fullscreen ---
    var tombolFull = document.createElement("div");
    tombolFull.innerText = "[ ]"; 
    tombolFull.style.fontSize = "25px"; 
    tombolFull.style.fontWeight = "bold";
    tombolFull.style.fontFamily = "Arial, sans-serif";
    tombolFull.style.cursor = "pointer";
    tombolFull.style.color = "black";
    tombolFull.style.transition = "color 0.3s ease";
    
    tombolFull.onclick = function() {
        if (!document.fullscreenElement) {
            layarBrat.requestFullscreen().catch(err => {
                console.log("Error fullscreen:", err);
            });
        }
    };

    // --- Tombol Tutup ---
    var tombolTutup = document.createElement("div");
    tombolTutup.innerText = "x";
    tombolTutup.style.fontSize = "25px"; 
    tombolTutup.style.fontWeight = "bold";
    tombolTutup.style.fontFamily = "Arial, sans-serif";
    tombolTutup.style.cursor = "pointer";
    tombolTutup.style.color = "black";
    tombolTutup.style.transition = "color 0.3s ease";
    
    tombolTutup.onclick = function() {
        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            layarBrat.style.display = "none";
            panelWarna.style.display = "none"; 
            panelWarnaTerbuka = false; // Reset sistem kunci
        }
    };

    wadahTombol.onmouseenter = function() { 
        wadahTombol.style.opacity = "1"; 
    };
    wadahTombol.onmouseleave = function() { 
        if (!panelWarnaTerbuka) { // Tombol HANYA hilang kalau menu warna tertutup
            wadahTombol.style.opacity = "0"; 
        }
    };

    wadahTombol.appendChild(tombolGear);
    wadahTombol.appendChild(tombolFull);
    wadahTombol.appendChild(tombolTutup);
    wadahTombol.appendChild(panelWarna); 
    layarBrat.appendChild(wadahTombol);
    document.body.appendChild(layarBrat);

    document.addEventListener("fullscreenchange", function() {
        if (document.fullscreenElement) {
            tombolFull.style.display = "none"; 
            tombolGear.style.display = "none"; 
            panelWarna.style.display = "none"; 
            panelWarnaTerbuka = false; // Reset sistem kunci saat masuk layar penuh
        } else {
            tombolFull.style.display = "block"; 
            tombolGear.style.display = "block"; 
        }
    });

    var tombolBrat = new Spicetify.Topbar.Button(
        "Brat Lyrics", 
        "lyrics", 
        function() {
            if (layarBrat.style.display === "none") {
                layarBrat.style.display = "flex"; 
                sedotLirikDariInternet();         
            }
        }
    );

    Spicetify.Player.addEventListener("songchange", function() {
        if (layarBrat.style.display === "flex") {
            sedotLirikDariInternet();
        }
    });

    Spicetify.Player.addEventListener("onprogress", function() {
        if (layarBrat.style.display === "none" || statusLirik !== "ada") return; 

        var detikSekarang = Spicetify.Player.getProgress() / 1000;
        var indeksDitemukan = -1;

        for (var i = 0; i < daftarLirik.length; i++) {
            if (detikSekarang >= daftarLirik[i].waktu) {
                indeksDitemukan = i;
            }
        }

        if (indeksDitemukan !== barisSaatIni) {
            barisSaatIni = indeksDitemukan;

            teksBrat.style.transition = "none";
            teksBrat.style.opacity = "0";

            if (barisSaatIni === -1 || daftarLirik[barisSaatIni].teks.trim() === "") {
                teksBrat.innerText = "..."; 
                teksBrat.style.fontSize = "90px";
                teksBrat.style.width = "auto";
            } else {
                var teksAktif = daftarLirik[barisSaatIni].teks;
                teksBrat.innerText = teksAktif;

                var baseFont = 90; 
                teksBrat.style.fontSize = baseFont + "px";
                teksBrat.style.lineHeight = "0.94"; 
                teksBrat.style.letterSpacing = "-4px"; 
                
                teksBrat.style.width = "10px";
                void teksBrat.offsetWidth; 
                var minWidth = teksBrat.scrollWidth;
                
                teksBrat.style.width = minWidth + "px";
                void teksBrat.offsetWidth;
                
                var targetWidth = minWidth;
                
                var safety = 0;
                while (teksBrat.offsetHeight > targetWidth && safety < 500) {
                    targetWidth += 10;
                    teksBrat.style.width = targetWidth + "px";
                    safety++;
                }
                
                var boxSizeLimit = 480;
                
                if (targetWidth <= boxSizeLimit) {
                    teksBrat.style.width = targetWidth + "px";
                } 
                else {
                    var ratio = boxSizeLimit / targetWidth;
                    var newFont = Math.floor(baseFont * ratio); 
                    
                    teksBrat.style.fontSize = newFont + "px";
                    teksBrat.style.width = boxSizeLimit + "px"; 
                    
                    if (newFont < 45) {
                        teksBrat.style.letterSpacing = "-1.5px";
                        teksBrat.style.lineHeight = "1.0"; 
                    } else if (newFont < 65) {
                        teksBrat.style.letterSpacing = "-2.5px";
                        teksBrat.style.lineHeight = "0.95";
                    }
                }
            }

            void teksBrat.offsetWidth;
            teksBrat.style.transition = "color 0.3s ease, opacity 0.4s ease-in";
            teksBrat.style.opacity = "1";
        }
    });
}

function sedotLirikDariInternet() {
    statusLirik = "mencari";
    
    teksBrat.innerText = "...";
    teksBrat.style.fontSize = "90px"; 
    teksBrat.style.width = "auto";
    teksBrat.style.opacity = "1"; 
    
    daftarLirik = []; 
    barisSaatIni = -1;

    var dataLagu = Spicetify.Player.data;
    if (!dataLagu) {
        statusLirik = "kosong";
        teksBrat.innerText = "putar lagu dulu dong...";
        return;
    }

    var artis = dataLagu.item ? dataLagu.item.artists[0].name : dataLagu.track.metadata.artist_name;
    var judul = dataLagu.item ? dataLagu.item.name : dataLagu.track.metadata.title;

    if (!artis || !judul) {
        statusLirik = "kosong";
        teksBrat.innerText = "info lagu gak terbaca...";
        return;
    }

    judul = judul.split(" - ")[0].split(" (")[0];
    var linkApi = "https://lrclib.net/api/get?artist_name=" + encodeURIComponent(artis) + "&track_name=" + encodeURIComponent(judul);

    fetch(linkApi)
        .then(respon => {
            if (!respon.ok) throw new Error("Gagal");
            return respon.json();
        })
        .then(data => {
            if (data && data.syncedLyrics) {
                bacaFormatLirik(data.syncedLyrics);
                statusLirik = "ada"; 
            } else {
                statusLirik = "kosong";
                teksBrat.innerText = "maaf lirik kosong";
            }
        })
        .catch(() => {
            statusLirik = "error";
            teksBrat.innerText = "gagal mengambil lirik";
        });
}

function bacaFormatLirik(teksLrc) {
    var barisBaris = teksLrc.split("\n");
    for (var i = 0; i < barisBaris.length; i++) {
        var teksBaris = barisBaris[i];
        var bukaKurung = teksBaris.indexOf("[");
        var tutupKurung = teksBaris.indexOf("]");
        
        if (bukaKurung !== -1 && tutupKurung !== -1) {
            var teksWaktu = teksBaris.substring(bukaKurung + 1, tutupKurung); 
            var teksNyanyi = teksBaris.substring(tutupKurung + 1).trim();     
            
            teksNyanyi = teksNyanyi.replace(/[(),.?!"']/g, "");
            
            var pisahWaktu = teksWaktu.split(":");
            if (pisahWaktu.length === 2 && teksNyanyi !== "") {
                var totalDetik = (parseFloat(pisahWaktu[0]) * 60) + parseFloat(pisahWaktu[1]);
                daftarLirik.push({ waktu: totalDetik, teks: teksNyanyi });
            }
        }
    }
}

mulaiEkstensiBrat();