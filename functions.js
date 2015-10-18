var Esq = require("esquery");
var Glob  = require("glob");
var Parse = require("esprima").parse;
var Fs = require("fs");
var Path = require("path");
var _ = require("underscore");
var Join = Path.join;

var usage =
  "Usage: node " + process.argv[1] + " [-v/--verbose] [-d/--debug] [DIR]\n"
 +"\n"
 +"    -v, --verbose    be more verbose\n"
 +"    -d, --debug      debug messages\n"
 +"    [DIR]            directory to scan\n"
 +"\n";

var debug = false;
var verbose = false;
var curDir;

var args = process.argv.slice();
args.shift();
args.shift();

args.forEach(function(arg){
		if(arg.match(/^--?v(erbose)?/)){
			verbose = true;
		}else if(arg.match(/^--?d(ebug)?$/)){
			debug = true;
			verbose = true;
		}else if(!curDir){
			curDir = arg;
		}else if(arg.match(/^--?h(elp)?$/)){
			process.stdout.write(usage);
			process.exit(0);
		}else{
			process.stderr.write(usage);
			process.exit(-1);
		}

});


var libFiles = [], serverFiles = [], clientFiles = [], testsFiles = [];

function ignoreFile(file, filePath) {
   return file.indexOf(".") === 0 ||
	(filePath === "package.js" || filePath === "packages.json" ||  filePath === "README.md");
}

function tree(root, dir, accs, acc) {
    if (Fs.existsSync(dir)) {

        Fs.readdirSync(dir).forEach(function(file) {
            var p = Path.join(dir, file);
            var relP = p.substring(root.length + 1);
            var accRec = acc;
            if (!ignoreFile(file, relP)) {
            	var stats = Fs.lstatSync(p);
            	if(stats.isSymbolicLink(p)){
            		if(debug)console.log("resolving symlink", p);
            		p = Fs.realpathSync(p);
            		if(debug)console.log("=>", p);
            		stats = Fs.lstatSync(p);
            		if(stats.isDirectory()){
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
                } else {
                    throw new Error("file not in lib, client or server: '" + relP + "'");
                }
            }
        });
    }

}


function globalsFromJSHintrc(curDir){
	var jshintrc = Path.join(curDir, ".jshintrc");
	try{
		if(Fs.existsSync(jshintrc)){
			if(Fs.statSync(jshintrc).isFile()){
				console.log("jshintrc", jshintrc);
				var contents = Fs.readFileSync(jshintrc, "utf8");
				// remove single-line comments
				contents=contents.replace(new RegExp("//[^\\n]+\\n", "g"), "\n");
				var jshint = JSON.parse(contents);
				return jshint && jshint.globals;
			}
		}
	}catch(e){
		console.log(e);
		//swallow error
	}
	var parentDir = Path.dirname(curDir);
	if(parentDir !== curDir){
		return globalsFromJSHintrc(parentDir);
	}
}

function getMemberFirstLevels(memberExpr){
	if(memberExpr.object.type === "MemberExpression"){
		return getMemberFirstLevels(memberExpr.object);
	}else if(memberExpr.object.type === "Identifier"){
		return memberExpr.object.name + "." + memberExpr.property.name;
	}else {
		console.error("E: unexpected identifier:", memberExpr);
		process.exit(1);
	}
}

function isInterestingIdentifier(globals, memberExpr){
	return (memberExpr.type === "MemberExpression") &&
			((memberExpr.object.type === "Identifier"
				&& (!globals || globals[memberExpr.object.name]))
				|| isInterestingIdentifier(globals, memberExpr.object));
}

function getDeclsRefs(file, globals, decls, refs) {
  if(verbose)console.log("reading "+file);
  var ast = Parse(Fs.readFileSync(file), parseOptions);
  var declsAST = Esq.query(ast, "AssignmentExpression");
  declsAST.forEach(function(p){
  	if(isInterestingIdentifier(globals, p.left)){
		var name = getMemberFirstLevels(p.left);
		var loc = file + ":" +  p.loc.start.line

  		if(debug)console.log(loc, "found decl", name);

		var type, arity;
		if(p.right.type === "FunctionExpression"){
			type = "function";
			arity = p.right.params.length
		}
		decls[name] = {
				loc: loc,
				type: type,
				arity: arity
		};
	}
  });
  
  var refsAST = Esq.query(ast, "CallExpression");
  refsAST.forEach(function(p){
  	if(isInterestingIdentifier(globals, p.callee)){
		var name = getMemberFirstLevels(p.callee);
		var loc = file + ":" +  p.loc.start.line

  		if(debug)console.log(loc, "found ref", name);

		var arity = p.arguments.length;

		refs.push({
				name: name,
				loc: loc,
				arity: arity
		});
	}
  });  
}


if(!curDir){
	curDir = process.cwd();
}

process.stdout.write("Scanning " + curDir + "...\n");

var globals = globalsFromJSHintrc(curDir);


delete globals["Meteor"];
delete globals["Cluster"];
delete globals["Tracker"];
delete globals["Npm"];
delete globals["_"];
delete globals["Fs"];
delete globals["Logger"];
delete globals["Router"];
delete globals["Session"];

var globOptions = { cwd: curDir };
var parseOptions = { loc: true };


tree(curDir, curDir, {
    lib: libFiles,
    client: clientFiles,
    server: serverFiles,
    tests: testsFiles
}, undefined);


var packages = Path.join(curDir, "packages");
if(Fs.existsSync(packages)){
	if(verbose)console.log("reading packages", packages);
	tree(packages, packages, {
		lib: libFiles,
		client: clientFiles,
		server: serverFiles,
		tests: testsFiles
	}, undefined);
}

var libDecls = [], libRefs = [];
var serverDecls = [], serverRefs = [];
var clientDecls = [], clientRefs = [];

if(debug)console.log("libFiles:", libFiles);
if(debug)console.log("serverFiles:", serverFiles);

var endsJS = /\.js$/;

function getRefDecls(type, files, decls, refs){
		
	files.forEach(function(f){
		if(f.match(endsJS)){
			getDeclsRefs(f, globals, decls, refs);
		}
	});
	// if(debug)console.log(type + "Decls:", decls);
	// if(debug)console.log(type + "Refs:", refs);
}


getRefDecls("lib", libFiles, libDecls, libRefs);
getRefDecls("server", serverFiles, serverDecls, serverRefs);
getRefDecls("client", clientFiles, clientDecls, clientRefs);

function checkRefs(declsA, refs){
	refs.forEach(function(ref){
			var decls = _.find(declsA, function(decls){
					return decls.hasOwnProperty(ref.name);
			});
			var decl = decls && decls[ref.name];
			if(decl){
				if(decl.arity < ref.arity){
					process.stderr.write(ref.loc+"\tcalled "+ref.name+"("+decl.arity+") with "+ref.arity+" parameters\n");
				}
			}else{
				process.stderr.write(ref.loc+"\treference to undefined '"+ref.name+"'\n");
			}
	});
}

checkRefs([libDecls], libRefs);
checkRefs([libDecls, serverDecls], serverRefs);
checkRefs([libDecls, clientDecls], clientRefs);