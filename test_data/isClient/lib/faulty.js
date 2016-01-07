if(Meteor.isClient){
	if(Meteor.isServer){
		console.log("I love dead code (recurse)");
	}
	if(Meteor.isClient){
		console.log("I'm redundant (recurse)");
	}
}

if(Meteor.isServer){
	if(Meteor.isClient){
		console.log("I love dead code (recurse)");
	}
	if(Meteor.isServer){
		console.log("I'm redundant (recurse)");
	}
}

var x = Meteor.isClient ? "client" : Session.get("illegalOnServer");
