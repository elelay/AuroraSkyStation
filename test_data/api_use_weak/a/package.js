Package.onUse(function(api) {

    api.use("y:b@0.0.1", ["server"], {
        weak: true
    });

    api.addFiles("server/a.js");
});
