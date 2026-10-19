// Draw: the last script on the page, and all it does is connect. Everything else is in by now --
// app.js, pad.js, gallery.js, tel.js -- so no server event can arrive while a file is still
// downloading and call into one that has not run yet (a phone on mobile data, through the tunnel).
socket.connect();
