Meteor.a = true;


function faulty(){
	if(Meteor.a()){
		console.log("a is not a function");
	}
}

function ok(){
	if(Meteor.a){
		console.log("a is a boolean");
	}
}