// this disables ref-domain error reporting
"use aurore::ref-domain false";

Router.route("/", function() {
    Session.set("home", "sweet home");
}, "home");
