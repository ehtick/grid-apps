// this is called from the `app.js` function `initModule()` around line `200`
// from there you can get the structure passed in the "server" object
// which includes and `api` and other helper functions

module.exports = function(server) {

server.util.log("--- sample server-side module installed ---");

// insert script after all others in kiri browser code
server.inject("kiri", "kiri.js", {end: true});

server.onload(() => {
    server.util.log("--- called after all modules loaded ---");
});


};
