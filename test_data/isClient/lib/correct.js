if(Meteor.isClient){
	var x = Session.get("toto");
}

if(Meteor.isServer){
	Meteor.publish("dummy");
}

var x = Meteor.isClient ? Session.get("session") : "server";
