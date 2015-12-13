Package.onUse(function(api) {
    var impliedPackages = [
        "y:package-b@0.0.1"
    ];
    api.use(impliedPackages);
    api.imply(impliedPackages);

    api.addFiles("lib/a.js");
});
