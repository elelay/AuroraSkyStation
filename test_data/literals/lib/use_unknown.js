if(Meteor.unknown_test){
	console.log("it's unknow...");
}

Meteor.unknown_expr;

Meteor.known_test = true;

if(Meteor.known_test){
	console.log("you should know...");
}

Meteor.known = 0;
Meteor.known + 1;
