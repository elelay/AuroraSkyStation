if(Meteor.isServer){
	console.log("I love dead code");
}

if(Meteor.isClient){
	console.log("I'm redundant");
}

var x = Meteor.isClient ? "redondant" : "dead";
