var Fs = require("fs");
var Path = require("path");

var Esprima = require("esprima");
var Escope = require("escope");
var Esq = require("esquery");

var parseOptions = {
    loc: true,
    range: true
};

var endsJS = /\.js$/;
var endsHTML = /\.html$/;

function ignoreFile(file, filePath) {
    return file.indexOf(".") === 0 ||
        (filePath === "package.js" || filePath === "packages.json" || filePath === "README.md" || filePath === "README");
}

function tree(root, dir, accs, acc) {
    if (Fs.existsSync(dir)) {

        Fs.readdirSync(dir).forEach(function(file) {
            var p = Path.join(dir, file);
            var relP = p.substring(root.length + 1);
            var accRec = acc;
            if (!ignoreFile(file, relP)) {
                var stats = Fs.lstatSync(p);
                if (stats.isSymbolicLink(p)) {
                    if (exports.debug) console.log("resolving symlink", p);
                    try {
                        Fs.statSync(p); // will throw an error before realPathSync does (and it's not catchable)
                        p = Fs.realpathSync(p);
                        if (exports.debug) console.log("=>", p);
                    } catch (e) {
                        exports.ErrorReporter.error("bad-link", p, "bad symlink: " + p);
                        return;
                    }
                    stats = Fs.lstatSync(p);
                    if (stats.isDirectory()) {
                        return tree(p, p, accs, acc);
                    }
                }
                if (stats.isDirectory()) {
                    switch (file) {
                        case "client":
                            accRec = acc || accs.client;
                            break;
                        case "server":
                            accRec = acc || accs.server;
                            break;
                        case "lib":
                            accRec = acc || accs.lib;
                            break;
                        case "tests":
                            accRec = acc || accs.tests;
                            break;
                        default:
                    }

                    tree(root, p, accs, accRec);

                } else if (acc) {
                    acc.push(p);
                } else if (relP.match(endsJS) || relP.match(endsHTML)) {
                    throw new Error("file not in lib, client or server: '" + relP + "'");
                }
            }
        });
    }

}

function getPackageDir(root, name) {
    var yname = name.match(/y:([^@]+)(@.+)?/);
    if (yname) {
        var n = yname[1];
        var packageDir = Path.resolve(root, "../" + n);
        if (Fs.existsSync(packageDir)) {
            return packageDir;
        } else {
            if (exports.debug) console.log("getPackageDir couldn't find", name, "(not in", packageDir, ")");
        }
    } else {
        if (exports.debug) console.log("getPackageDir no rule for", name);
    }
}

/*
 * to later access all references in linear time.
 * Unused for now because very few variable references in package.js
function computeReferences(scopeManager) {
    var res = [];
    scopeManager.scopes.forEach(function(scope) {
        scope.references.forEach(function(ref) {
            res.push(ref);
        });
    });
    return res;
}
 */

function findReference(scopeManager, nodeRef) {
    var res = null;
    scopeManager.scopes.forEach(function(scope) {
        scope.references.forEach(function(ref) {
            if (ref.identifier === nodeRef) {
                res = ref;
            }
        });
    });
    return res;
}

function getArrayContents(file, allRefs, node) {
    var packages;
    if (node.type === "ArrayExpression") {
        packages = node.elements.map(function(elt) {
            return elt.value;
        });
    } else if (node.type === "Literal")  {
        packages = [node.value];
    } else if (node.type === "Identifier") {
        //var ref = _.find(allRefs, function(r){ return r.identifier === node;});
        var ref = findReference(allRefs, node);
        if (ref) {
            if (ref.resolved.defs.length === 1) {
                var def = ref.resolved.defs[0];
                if (def.node.type === "VariableDeclarator") {
                    var init = def.node.init;
                    packages = getArrayContents(file, allRefs, init);
                }
            } else {
                console.error("E:", file, node.name, "has", ref.resolved.defs.length, "definitions");
                packages = [];
            }
        } else {
            console.error("E:", file, "declaration of", node.name, "not found");
            packages = [];
        }
    } else {
        console.error("E: unsupported argument to api.use", node.loc.file, node);
    }

    if (exports.debug) console.log("D: api.use(" + packages + ")");
    return packages;
}

function treePackageJS(root, curDir, files) {
    var packageJS = Path.join(curDir, "package.js");
    if (Fs.existsSync(packageJS)) {
        if (exports.verbose) console.log("following", packageJS);

        var ast = Esprima.parse(Fs.readFileSync(packageJS), parseOptions);
        var scopeManager = Escope.analyze(ast);
        //var allRefs = computeReferences(scopeManager);

        var uses = Esq.query(ast, "CallExpression");
        uses.forEach(function(p) {
            var isApiUse = (p.callee.type === "MemberExpression") &&
                p.callee.object && (p.callee.object.name === "api") &&
                p.callee.property && (p.callee.property.name === "use") &&
                (p.arguments.length === 1 || p.arguments.length === 2);
            if (isApiUse) {
                //var packages = getArrayContents(packageJS, allRefs, p.arguments[0]);
                var packages = getArrayContents(packageJS, scopeManager, p.arguments[0]);
                packages.forEach(function(name) {
                    var packageDir = getPackageDir(root, name);
                    if (exports.debug) console.log("package", name, "=>", packageDir);
                    if (packageDir) {
                        tree(packageDir, packageDir, files, undefined);

                        treePackageJS(root, packageDir, files);
                    }
                });
            }
        });

    }
}

function globalsFromJSHintrc(curDir) {
    var jshintrc = Path.join(curDir, ".jshintrc");
    try {
        if (Fs.existsSync(jshintrc)) {
            if (Fs.statSync(jshintrc).isFile()) {
                if(exports.verbose)console.log("jshintrc", jshintrc);
                var contents = Fs.readFileSync(jshintrc, "utf8");
                // remove single-line comments
                contents = contents.replace(new RegExp("//[^\\n]+\\n", "g"), "\n");
                var jshint = JSON.parse(contents);
                return jshint && jshint.globals;
            }
        }
    } catch (e) {
        console.log(e);
        //swallow error
    }
    var parentDir = Path.dirname(curDir);
    if (parentDir !== curDir) {
        return globalsFromJSHintrc(parentDir);
    }
}

// exported functions
exports.tree = tree;
exports.treePackageJS = treePackageJS;
exports.globalsFromJSHintrc = globalsFromJSHintrc;

// options
exports.debug = false;
exports.verbose = false;
exports.ErrorReporter = require("./error_reporter");
