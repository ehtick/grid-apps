/** Copyright Stewart Allen <sa@grid.space> -- All Rights Reserved */

"use strict";

(function() {

    let KIRI = self.kiri,
        BASE = self.base,
        UTIL = BASE.util,
        FDM = KIRI.driver.FDM;

    /**
     * @returns {Array} gcode lines
     */
    FDM.export = function(print, online) {
        let layers = print.output,
            settings = FDM.fixExtruders(print.settings),
            getRangeParameters = FDM.getRangeParameters,
            device = settings.device,
            extruders = device.extruders,
            gcodeFan = device.gcodeFan,
            gcodeLayer = device.gcodeLayer,
            gcodeTrack = device.gcodeTrack,
            tool = 0,
            isDanger = settings.controller.danger,
            isBelt = device.bedBelt,
            bedType = isBelt ? "belt" : "fixed",
            extruder = extruders[tool],
            offset_x = extruder.extOffsetX,
            offset_y = extruder.extOffsetY,
            extrudeAbs = device.extrudeAbs || false,
            extrudeSet = false,
            time = 0,
            layer = 0,
            pause = [],
            pauseCmd = device.gcodePause,
            output = [],
            outputLength = 0, // absolute extruder position
            lastProgress = 0,
            decimals = BASE.config.gcode_decimals || 4,
            progress = 0,
            distance = 0,
            emitted = 0,
            retracted = 0,
            pos = {x:0, y:0, z:0, f:0},
            lout = null,
            last = null,
            zpos = 0,
            process = settings.process,
            loops = process.outputLoopLayers,
            zhop = process.zHopDistance || 0, // range
            seekMMM = process.outputSeekrate * 60,
            retDist = process.outputRetractDist, // range
            retSpeed = process.outputRetractSpeed * 60, // range
            retDwell = process.outputRetractDwell || 0, // range
            timeDwell = retDwell / 1000,
            arcDist = isBelt || !isDanger ? 0 : (process.arcTolerance || 0),
            originCenter = process.outputOriginCenter,
            offset = originCenter ? null : {
                x: device.bedWidth/2,
                y: isBelt ? 0 : device.bedDepth/2
            },
            subst = {
                travel_speed: seekMMM,
                retract_speed: retSpeed,
                retract_distance: retDist,
                temp: process.firstLayerNozzleTemp || process.outputTemp, // range
                temp_bed: process.firstLayerBedTemp || process.outputBedTemp, // range
                bed_temp: process.firstLayerBedTemp || process.outputBedTemp, // range
                fan_speed: process.outputFanMax,
                speed: process.outputFanMax, // legacy
                top: offset ? device.bedDepth : device.bedDepth/2,
                left: offset ? 0 : -device.bedWidth/2,
                right: offset ? device.bedWidth : device.bedWidth/2,
                bottom: offset ? 0 : -device.bedDepth/2,
                z_max: device.maxHeight,
                layers: layers.length,
                nozzle: 0,
                tool: 0
            },
            pidx, path, out, speedMMM, emitMM, emitPerMM, lastp, laste, dist,
            append,
            lines = 0,
            bytes = 0,
            bcos = Math.cos(Math.PI/4),
            icos = 1 / bcos,
            inLoop,
            params,
            arcQ = [];

        if (isBelt && loops) {
            loops = loops.split(',').map(range => {
                return range.split('-').map(v => parseInt(v));
            }).filter(a => a.length > 1).map(a => {
                return {
                    start: a[0],
                    end: a[1] ? a[1] + 1 : Infinity,
                    iter: a[2] >= 0 ? a[2] : 1
                }
            });
        }
        if (!isBelt || (loops && loops.length < 1)) {
            loops = undefined;
        }

        (process.gcodePauseLayers || "").split(",").forEach(function(lv) {
            let v = parseInt(lv);
            if (v >= 0) pause.push(v);
        });

        // console.log(loops)

        append = function(line) {
            if (line) {
                lines++;
                bytes += line.length;
                output.append(line);
            }
            if (!line || output.length > 1000) {
                online(output.join("\n"));
                output = [];
            }
        };

        function appendSubPad(line, pad) {
            appendSub(line, true);
        }

        function appendSub(line, pad) {
            append(print.constReplace(line, subst, 0, pad));
        }

        function appendAll(arr) {
            if (!arr) return;
            if (!Array.isArray(arr)) arr = [ arr ];
            arr.forEach(function(line) { append(line) });
        }

        function appendAllSub(arr, pad) {
            if (!arr || arr.length === 0) return;
            if (!Array.isArray(arr)) arr = [ arr ];
            arr.forEach(function(line) { appendSub(line, pad) });
        }

        append(`; Generated by Kiri:Moto ${KIRI.version}`);
        append(`; ${new Date().toString()}`);
        appendSub("; Bed left:{left} right:{right} top:{top} bottom:{bottom}");
        append(`; Bed type: ${bedType}`);
        append(`; Target: ${settings.filter[settings.mode]}`);
        append("; --- process ---");
        for (let pk in process) {
            append("; " + pk + " = " + process[pk]);
        }
        append("; --- startup ---");
        let t0 = false;
        let t1 = false;
        for (let i=0; i<device.gcodePre.length; i++) {
            let line = device.gcodePre[i];
            if (line.indexOf('T0') >= 0) t0 = true; else
            if (line.indexOf('T1') >= 0) t1 = true; else
            if (line.indexOf('M82') >= 0) {
                extrudeAbs = true;
                extrudeSet = true;
            } else
            if (line.indexOf('M83') >= 0) {
                extrudeAbs = false;
                extrudeSet = true;
            } else
            if (line.indexOf('G90') >= 0 && !extrudeSet) extrudeAbs = true; else
            if (line.indexOf('G91') >= 0 && !extrudeSet) extrudeAbs = false; else
            if (line.indexOf('G92') === 0) {
                line.split(";")[0].split(' ').forEach(function (tok) {
                    let val = parseFloat(tok.substring(1) || 0) || 0;
                    switch (tok[0]) {
                        case 'X': pos.x = val; break;
                        case 'Y': pos.y = val; break;
                        case 'Z': pos.z = val; break;
                        case 'E': outputLength = val; break;
                    }
                });
            }
            if (extrudeAbs && line.indexOf('E') > 0) {
                line.split(";")[0].split(' ').forEach(function (tok) {
                    // use max E position from gcode-preamble
                    if (tok[0] == 'E') {
                        outputLength = Math.max(outputLength, parseFloat(tok.substring(1)) || 0);
                    }
                });
            }
            if (line.indexOf("{tool}") > 0 && extruders.length > 1) {
                for (let i=0; i<extruders.length; i++) {
                    subst.tool = i;
                    appendSubPad(line);
                }
                subst.tool = 0;
            } else {
                appendSubPad(line);
            }
        }

        function dwell(ms) {
            append(`G4 P${ms}`);
            time += timeDwell;
        }

        function retract(zhop) {
            if (retracted) {
                // console.log({double_retract: zhop});
                return;
            }
            retracted = retDist;
            moveTo({e:-retracted}, retSpeed, `e-retract ${retDist}`);
            if (zhop) moveTo({z:zpos + zhop}, seekMMM, "z-hop start");
            time += (retDist / retSpeed) * 60 * 2; // retraction time
        }

        let taxis = new THREE.Vector3( 1, 0, 0 );
        let tcent = new THREE.Vector2( 0, 0 );
        let angle = -Math.PI / 4;

        function moveTo(newpos, rate, comment) {
            let o = [!rate && !newpos.e ? 'G0' : 'G1'];
            let emit = { x: false, y: false, z: false };
            if (typeof newpos.x === 'number' && newpos.x !== pos.x) {
                pos.x = newpos.x;
                emit.x = true;
            }
            if (typeof newpos.y === 'number' && newpos.y !== pos.y) {
                pos.y = newpos.y;
                emit.y = true;
                if (isBelt) emit.z = true;
            }
            if (typeof newpos.z === 'number' && newpos.z !== pos.z) {
                pos.z = newpos.z;
                emit.z = true;
                if (isBelt) emit.y = true;
            }
            let epos = isBelt ? { x: pos.x, y: pos.y, z: pos.z } : pos;
            if (isBelt) {
                epos.x = originCenter ? -pos.x : device.bedWidth - pos.x;
                epos.z = pos.z * icos;
                epos.y = -pos.y + epos.z * bcos;
                lout = epos;
            }
            if (emit.x) o.append(" X").append(epos.x.toFixed(decimals));
            if (emit.y) o.append(" Y").append(epos.y.toFixed(decimals));
            if (emit.z) o.append(" Z").append(epos.z.toFixed(decimals));
            if (typeof newpos.e === 'number') {
                outputLength += newpos.e;
                if (extrudeAbs) {
                    // for cumulative (absolute) extruder positions
                    o.append(" E").append(outputLength.toFixed(decimals));
                } else {
                    o.append(" E").append(newpos.e.toFixed(decimals));
                }
            }
            if (rate && rate != pos.f) {
                o.append(" F").append(Math.round(rate));
                pos.f = rate
            }
            if (comment) {
                o.append(` ; ${comment}`);
            }
            let line = o.join('');
            if (last == line) {
                // console.log({dup:line});
                return;
            }
            last = line;
            append(line);
        }

        // calc total distance traveled by head as proxy for progress
        let allout = [], totaldistance = 0;
        layers.forEach(function(outs) {
            allout.appendAll(outs);
        });
        allout.forEachPair(function (o1, o2) {
            totaldistance += o1.point.distTo2D(o2.point);
        }, 1);

        // retract before first move
        retract();

        while (layer < layers.length) {
            path = layers[layer];
            params = getRangeParameters(settings, path.layer);
            // TODO update process settings from params override
            // console.log(path.layer, params)

            emitPerMM = print.extrudePerMM(
                extruder.extNozzle,
                extruder.extFilament,
                path.layer === 0 ?
                    (process.firstSliceHeight || process.sliceHeight) : path.height);

            zpos = path.z;
            subst.z = subst.Z = zpos.round(3);
            subst.e = subst.E = outputLength;
            subst.layer = layer;
            subst.height = path.height.toFixed(3);

            if (isBelt) {
                pos.z = zpos;
            }

            if (pauseCmd && pause.indexOf(layer) >= 0) {
                appendAllSub(pauseCmd)
            }

            if (loops) {
                if (inLoop) {
                    if (layer === inLoop.end) {
                        append(`M808`);
                        inLoop = undefined;
                    }
                } else {
                    for (let loop of loops) {
                        if (layer === loop.start) {
                            append(`M808 L${loop.iter}`);
                            if (extrudeAbs) {
                                append(`G92 Z${lout.z.round(decimals)} E${outputLength.round(decimals)}`);
                            } else {
                                append(`G92 Z${lout.z.round(decimals)}`);
                            }
                            inLoop = loop;
                            break;
                        }
                    }
                }
            }

            if (gcodeLayer && gcodeLayer.length) {
                appendAllSub(gcodeLayer);
            } else {
                append(`;; --- layer ${layer} (${subst.height} @ ${subst.z.round(3)}) ---`);
            }

            // enable fan at fan layer
            if (gcodeFan && layer === process.outputFanLayer) {
                appendAllSub(gcodeFan);
            }

            // second layer transitions
            if (layer === 1) {
                // update temps when first layer overrides are present
                if (process.firstLayerNozzleTemp) {
                    subst.temp = process.outputTemp; // range
                    if (t0) appendSub("M104 S{temp} T0");
                    if (t1) appendSub("M104 S{temp} T1");
                    if (!(t0 || t1)) appendSub("M104 S{temp} T{tool}");
                }
                if (process.firstLayerBedTemp) {
                    subst.bed_temp = subst.temp_bed = process.outputBedTemp; // range
                    appendSub("M140 S{temp_bed} T0");
                }
            }

            // move Z to layer height
            if (layer > 0 || !isBelt) {
                moveTo({z:zpos}, seekMMM);
            }

            // iterate through layer outputs
            for (pidx=0; pidx<path.length; pidx++) {
                out = path[pidx];
                speedMMM = (out.speed || process.outputFeedrate) * 60; // range

                // look for extruder change, run scripts, recalc emit factor
                if (out.tool !== undefined && out.tool !== tool) {
                    appendAllSub(extruder.extDeselect);
                    tool = out.tool;
                    subst.nozzle = subst.tool = tool;
                    extruder = extruders[tool];
                    offset_x = extruder.extOffsetX;
                    offset_y = extruder.extOffsetY;
                    emitPerMM = print.extrudePerMM(
                        extruder.extNozzle,
                        extruder.extFilament,
                        path.layer === 0 ?
                            (process.firstSliceHeight || process.sliceHeight) : path.height);
                    appendAllSub(extruder.extSelect);
                }

                // if no point in output, it's a dwell command
                if (!out.point) {
                    dwell(out.speed);
                    continue;
                }

                let x = out.point.x + offset_x,
                    y = out.point.y + offset_y,
                    z = out.point.z;

                // adjust for inversions and origin offsets
                if (process.outputInvertX) x = -x;
                if (process.outputInvertY) y = -y;
                if (offset) {
                    x += offset.x;
                    y += offset.y;
                }

                dist = lastp ? lastp.distTo2D(out.point) : 0;

                // re-engage post-retraction before new extrusion
                if (out.emit && retracted) {
                    drainQ();
                    // console.log({engage:zhop});
                    // when enabled, resume previous Z
                    if (zhop && pos.z != zpos) moveTo({z:zpos}, seekMMM, "z-hop end");
                    // re-engage retracted filament
                    moveTo({e:retracted}, retSpeed, `e-engage ${retracted}`);
                    retracted = 0;
                    // optional dwell after re-engaging filament to allow pressure to build
                    if (retDwell) dwell(retDwell);
                    time += (retDist / retSpeed) * 60 * 2; // retraction time
                }

                if (lastp && out.emit) {
                    if (arcDist) {
                        let rec = {e:out.emit, x, y, z, dist, emitPerMM, speedMMM};
                        arcQ.push(rec);
                        let deem = false;
                        let depm = false;
                        let desp = false;
                        if (arcQ.length > 1) {
                            deem = arcQ[0].e !== rec.e;
                            depm = arcQ[0].emitPerMM !== rec.emitPerMM;
                            desp = arcQ[0].speedMMM !== rec.speedMMM;
                        }
                        if (arcQ.length > 2) {
                            let el = arcQ.length;
                            let e1 = arcQ[el-3];
                            let e2 = arcQ[el-2];
                            let e3 = arcQ[el-1];
                            let cc = BASE.util.center2d(e1, e2, e3, 1);
                            let dc = 0;
                            if (arcQ.length === 3) {
                                arcQ.center = [ cc ];
                            } else {
                                // check center point delta
                                let dx = cc.x - arcQ.center[0].x;
                                let dy = cc.y - arcQ.center[0].y;
                                dc = Math.sqrt(dx * dx + dy * dy);
                            }
                            // if new point is off the arc
                            if (deem || depm || desp || dc > arcDist) {
                                // console.log({dc, depm, desp});
                                if (arcQ.length === 4) {
                                    // not enough points for an arc, drop first point and recalc center
                                    emitQrec(arcQ.shift());
                                    arcQ.center = [ BASE.util.center2d(arcQ[0], arcQ[1], arcQ[2], 1) ];
                                } else {
                                    // enough to consider an arc, emit and start new arc
                                    let defer = arcQ.pop();
                                    drainQ();
                                    // re-add point that was off the last arc
                                    arcQ.push(defer);
                                }
                            } else {
                                // new point is on the arc
                                arcQ.center.push(cc);
                            }
                        }
                    } else {
                        emitMM = emitPerMM * out.emit * dist;
                        moveTo({x:x, y:y, e:emitMM}, speedMMM);
                        emitted += emitMM;
                    }
                } else {
                    drainQ();
                    moveTo({x:x, y:y}, seekMMM);
                    // TODO disabling out of plane z moves until a better mechanism
                    // can be built that doesn't rely on computed zpos from layer heights...
                    // when making z moves (like polishing) allow slowdown vs fast seek
                    // let moveSpeed = (lastp && lastp.z !== z) ? speedMMM : seekMMM;
                    // moveTo({x:x, y:y, z:z}, moveSpeed);
                }

                // retract filament if point retract flag set
                if (out.retract) {
                    drainQ();
                    retract(zhop);
                }

                // update time and distance (should calc in moveTo() instead)
                time += (dist / speedMMM) * 60 * 1.5;
                distance += dist;
                subst.progress = progress = Math.round((distance / totaldistance) * 100);

                // emit tracked progress
                if (gcodeTrack && progress != lastProgress) {
                    appendAllSub(gcodeTrack);
                    lastProgress = progress;
                }

                lastp = out.point;
                laste = out.emit;
            }
            layer++;
        }
        drainQ();

        function emitQrec(rec) {
            let {e, x, y, dist, emitPerMM, speedMMM} = rec;
            emitMM = emitPerMM * e * dist;
            moveTo({x:x, y:y, e:emitMM}, speedMMM);
            emitted += emitMM;
        }

        function drainQ() {
            if (!arcDist) {
                return;
            }
            if (arcQ.length > 4) {
                let area = BASE.newPolygon().addObj(arcQ).area();
                let from = arcQ[0];
                let to = arcQ.peek();
                let cc = {x:0, y:0, z:0, r:0};
                let cl = 0;
                for (let center of arcQ.center.filter(rec => !isNaN(rec.r))) {
                    cc.x += center.x;
                    cc.y += center.y;
                    cc.z += center.z;
                    cc.r += center.r;
                    cl++;
                }
                cc.x /= cl;
                cc.y /= cl;
                cc.z /= cl;
                cc.r /= cl;
                // first arc point
                emitQrec(from);
                // console.log(arcQ.slice(), arcQ.center);
                // console.log({first: from, last: arcQ.peek(), center: cc});
                // rest of arc to final point
                let dist = arcQ.slice(1).map(v => v.dist).reduce((a,v) => a+v);
                let emit = from.e;//arcQ.slice(1).map(v => v.e).reduce((a,v) => a+v);
                emit = (from.emitPerMM * emit * dist);
                outputLength += emit;
                emitted += emit;
                if (extrudeAbs) {
                    emit = outputLength;
                }
                let gc = area > 0 ? 'G2' : 'G3';
                let pre = `${gc} X${to.x.toFixed(decimals)} Y${to.y.toFixed(decimals)} R${cc.r.toFixed(decimals)} E${emit.toFixed(decimals)}`;
                let add = pos.f !== from.speedMMM ? ` E${from.speedMMM}` : '';
                append(`${pre}${add} ; merged=${cl-1} len=${dist.toFixed(decimals)} cp=${cc.x.round(2)},${cc.y.round(2)}`);
                pos.x = to.x;
                pos.y = to.y;
                pos.z = to.z;
            } else {
                for (let rec of arcQ) {
                    emitQrec(rec);
                }
            }
            arcQ.length = 0;
            arcQ.center = undefined;
        }

        if (inLoop) {
            append(`M808`);
        }

        subst.time = UTIL.round(time,2);
        subst.material = UTIL.round(emitted,2);

        append("; --- shutdown ---");
        appendAllSub(device.gcodePost);
        append(`; --- filament used: ${subst.material} mm ---`);
        append(`; --- print time: ${time.toFixed(0)}s ---`);

        // force emit of buffer
        append();

        print.distance = emitted;
        print.lines = lines;
        print.bytes = bytes + lines - 1;
        print.time = time;
    };

})();
