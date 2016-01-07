if(Meteor.isClient){
	console.log("I love dead code");
}

if(Meteor.isServer){
	console.log("I'm redundant");
}

Meteor.isServer ? "server" : Meteor.methods({});