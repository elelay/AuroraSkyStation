var Esq = require("esquery");
var Glob  = require("glob");
var Parse = require("esprima").parse;
var Fs = require("fs");
var _ = require("underscore");
var Join = require("path").join;

var usage = "Usage: pubsub";

var debug = false;

var curDir = process.cwd();
if(process.argv.length > 2){
  curDir = process.argv[2];
}
var globOptions = { cwd: curDir };
var parseOptions = { loc: true };
process.stdout.write("Scanning " + curDir + "...\n");

var publish = {};
var serverFiles = Glob.sync("**/server/**/*.js", globOptions);
serverFiles.forEach(function(f){
  if(debug)console.log("reading "+f);
  var ast = Parse(Fs.readFileSync(Join(curDir,f)), parseOptions);
  var pubs = Esq.query(ast, "Program > ExpressionStatement > CallExpression[callee.object.name = 'Meteor'][callee.property.name='publish']");
  pubs.forEach(function(p){
    publish[p.arguments[0].value] = f;
  });
});

if(debug)console.log("publish:" + _.keys(publish).join(", "));

var subscribes = {};

var clientFiles = Glob.sync("**/*.js", globOptions);
clientFiles.forEach(function(f){
  if(debug)console.log("reading "+f);
  var ast = Parse(Fs.readFileSync(Join(curDir, f)), parseOptions);
  var subs = Esq.query(ast, "CallExpression[callee.property.name='subscribe']");
  subs.forEach(function(sub){
    var name = sub.arguments[0].value;
    var loc = f + ":" +  sub.loc.start.line;
    if(!subscribes[name]){
      subscribes[name] = [];
    }
    subscribes[name].push(loc);
  });
});
_.keys(subscribes).forEach(function(name){
  if(publish[name]){
    if(debug){
      console.log(name);
      console.log("\t"+subscribes[name].join("\n\t"));
    }
  } else {
    subscribes[name].forEach(function(loc){
      process.stderr.write(Join(curDir,loc)+"\tno publish '"+name+"' in project\n");
    });
  }
});
