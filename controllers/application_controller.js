var models = require('../models/models.js');
var fs = require('fs');
var uuid = require('uuid');
var mmm = require('mmmagic'),
    Magic = mmm.Magic;

var Sequelize = require('sequelize');
const Op = Sequelize.Op;

var magic = new Magic(mmm.MAGIC_MIME_TYPE);

// Autoload info if path include applicationid
exports.load = function(req, res, next, applicationId) {

	// Search application whose id is applicationId
	models.oauth_client.findById(applicationId).then(function(application) {
		// If application exists, set image from file system
		if (application) {
			req.application = application
			if (application.image == 'default') {
				req.application.image = '/img/logos/original/app.png'
			} else {
				req.application.image = '/img/applications/'+application.image
			}
			// Send request to next function
			next();
		} else { next(new Error("The application with id " + applicationId + " doesn't exist"));}
	}).catch(function(error) { next(error); });
};


// Middleware to see user permissions in the application
exports.owned_permissions = function(req, res, next) {

	// Search roles owned by user in the application
	models.role_user.findAll({
		where: { user_id: req.session.user.id, 
				 oauth_client_id: req.application.id }
	}).then(function(user_application) {

		// Use the roles of the user to obtain all permissions 
		if (user_application.length > 0) {
			var user_roles = []
			user_application.forEach(function(app) {
				user_roles.push(app.role_id)
			});

			// Search permissions using the roles obtained
			models.role_permission.findAll({
				where: { role_id: user_roles },
				attributes: ['permission_id'],
			}).then(function(user_permissions) {
				var user_permissions_id = []
				user_permissions.forEach(function(app) {
					user_permissions_id.push(app.permission_id)
				});
				// Check if the user can access to a specific route according to his permissions
				if(check_user_action(req.application, req.path, req.method, user_permissions_id)) {
					next();	
				} else {
					// Send an error if the the request is via AJAX or redirect if is via browser
					if (req.xhr) {
						res.send('error');
					} else {
						res.redirect('/idm/applications');
					}
				}
			}).catch(function(error) { next(error); });
		} else { res.redirect('/idm/applications'); }
	}).catch(function(error) { next(error); });
}

// GET /idm/applications -- List all applications
exports.index = function(req, res) {

	// Search applications in which the user is authorized
	models.role_user.findAll({
		where: { user_id: req.session.user.id },
		include: [{
			model: models.oauth_client,
			attributes: ['id', 'name', 'url', 'image']
		}]
	}).then(function(user_applications) {
		// Set message to send when rendering view and delete from request
		if (req.session.message) {
			res.locals.message = req.session.message;
			delete req.session.message
		}

		// If user has applications, set image from file system and obtain info from each application
		if (user_applications.length > 0) {
			var applications = []
			user_applications.forEach(function(app) {
				if (applications.length == 0 || !applications.some(elem => (elem.id == app.OauthClient.id))) {
					if (app.OauthClient.image == 'default') {
						app.OauthClient.image = '/img/logos/medium/app.png'
					} else {
						app.OauthClient.image = '/img/applications/'+app.OauthClient.image
					}
					applications.push(app.OauthClient)
				} 
			});

			// Order applications and render view
			applications.sort(function(a,b) {return (a.name > b.name) ? 1 : ((b.name > a.name) ? -1 : 0);} )
			res.render('applications/index', { applications: applications, errors: []});

		} else {
			res.render('applications/index', { applications: [], errors: []});
		}
	}).catch(function(error) { next(error); });
};

// GET /idm/applications/:applicationId -- Show info about an application
exports.show = function(req, res, next) {

	// Search info about the users authorized in the application
	models.role_user.findAll({
		where: { oauth_client_id: req.application.id },
		include: [{
			model: models.user,
			attributes: ['id', 'username']
		}]
	}).then(function(users_application) {
		// Array of users authorized in the application
		var users_authorized = []
		// Array of roles owned by the user logged
		var user_logged_roles = []

		users_application.forEach(function(app) {
			if(app.User.id === req.session.user.id) {
				user_logged_roles.push(app.role_id)
			}
			if(users_authorized.some(elem => elem.user_id === app.User.id) === false) {
				users_authorized.push({ user_id: app.User.id, 
										username: app.User.username });
			} 
		});

		// Search permissions using the roles of the user logged			
		models.role_permission.findAll({
			where: { role_id: user_logged_roles },
			attributes: ['permission_id'],
		}).then(function(user_logged_permissions) {
			if(user_logged_permissions.length > 0) {
				// Set message to send when rendering view and delete from request
				if (req.session.message) {
					res.locals.message = req.session.message;
					delete req.session.message
				}

				// Search iot sensors of application
				models.iot.findAll({
					where: { oauth_client_id: req.application.id },
					attributes: ['id','password'],
				}).then(function(iot_sensors) {

					// Search pep proxy of application
					models.pep_proxy.findOne({
						where: { oauth_client_id: req.application.id },
						attributes: ['id','password'],
					}).then(function(pep_proxy) {
						res.render('applications/show', { application: req.application, 
														  users_authorized: users_authorized, 
														  user_logged_permissions: user_logged_permissions,
														  pep_proxy: pep_proxy,
														  iot_sensors: iot_sensors,																	  
														  errors: [] });

					}).catch(function(error) { next(error); });
				}).catch(function(error) { next(error); });

			} else { res.render('applications/show', { 	application: req.application, 
														users_authorized: users_authorized, 
														user_logged_permissions: [],
														pep_proxy: undefined,
														iot_sensors: [],																	  
														errors: [] }); }
		}).catch(function(error) { next(error); });
	}).catch(function(error) { next(error); });
	
};

// GET /idm/applications/new -- Render a view to create a new application
exports.new = function(req, res) {
	res.render('applications/new', {application: {}, errors: []})
};
	
// POST /idm/applications -- Create application
exports.create = function(req, res, next) {

	// If body has parameters id or is_internal don't create application
	if (req.body.id || req.body.secret) {
		req.session.message = {text: ' Application creation failed.', type: 'danger'};
		res.redirect('/idm/applications')
	} else {
		// Build a row and validate if input values are correct (not empty) before saving values in oauth_client
		var application = models.oauth_client.build(req.body.application);
		application.validate().then(function(err) {
			application.save({fields: [ 'id', 
										'name', 
										'description', 
										'url', 
										'redirect_uri', 
										'secret', 
										'image']
			}).then(function(){
				// Assign by default the provider role to the user who is creating the application
        		models.role_user.create({ oauth_client_id: application.id, 
        								  role_id: 'provider', 
        								  user_id: req.session.user.id}
        		).then(function(newAssociation) {
					res.redirect('/idm/applications/'+application.id+'/step/avatar');
				})
			});

		// Render the view once again, sending the error found when validating
		}).catch(function(error){ 
		 	res.render('applications/new', { application: application, errors: error.errors}); 
		});
	}	
};

// GET /idm/applications/:applicationId/step/avatar -- Form to create avatar when creating an application
exports.step_new_avatar = function(req, res, next) {
	res.render('applications/step_create_avatar', { application: req.application, errors: []});
};

// POST /idm/applications/:applicationId/step/avatar -- Create Avatar when creating an application
exports.step_create_avatar = function(req, res, next) {

	// See if the user has selected a image to upload
	if (req.file) {

		// Check the MIME of the file upload
		var types = ['jpg', 'jpeg', 'png']
		magic.detectFile('public/img/applications/'+req.file.filename, function(err, result) {
			if (types.includes(String(result.split('/')[1]))) {
				// If the file is jpg, png or jpeg, update the application with the name of the image
				models.oauth_client.update(
					{ image: req.file.filename },
					{
						fields: ["image"],
						where: {id: req.application.id }
					}
				).then(function(){
					req.application.image = '/img/applications/'+req.file.filename
					res.redirect('/idm/applications/'+req.application.id+'/step/roles');
				}).catch(function(error) {
					res.send('error')
				});
			} else {
				// If not, delete the image 
				fs.unlink('./public/img/applications/'+req.file.filename, (err) => {
					req.session.message = {text: ' Inavalid file.', type: 'danger'};
					res.redirect('/idm/applications/'+req.application.id);            
				});
			}	
		});

	// If not, the default image is assigned to the application
	} else {
		req.application.image = '/img/logos/original/app.png'
		res.redirect('/idm/applications/'+req.application.id+'/step/roles');
	}
};

// GET /idm/applications/:applicationId/step/roles -- Form to assign roles when creating an application
exports.step_new_roles = function(req, res, next) {

	// Search roles of application and order them
	models.role.findAll({
		where: { [Op.or]: [{oauth_client_id: req.application.id}, {is_internal: true}] },
		attributes: ['id', 'name'],
		order: [['id', 'DESC']]
	}).then(function(roles) {
		// Search permissions of application and order them
		models.permission.findAll({
			where: { [Op.or]: [{oauth_client_id: req.application.id}, {is_internal: true}] },
			attributes: ['id', 'name'], 
			order: [['id', 'ASC']]
		}).then(function(permissions) {
			// Search roles to permission assignment of application using id of roles
			models.role_permission.findAll({
				where: { role_id: roles.map(elem => elem.id) }						
			}).then(function(application_roles_permissions) {
				// Create and object with key as id of role and value an array of permissions id
				role_permission_assign = {}
				for (var i = 0; i < application_roles_permissions.length; i++) {
					if (!role_permission_assign[application_roles_permissions[i].role_id]) {
				        role_permission_assign[application_roles_permissions[i].role_id] = [];
				    }
				    role_permission_assign[application_roles_permissions[i].role_id].push(application_roles_permissions[i].permission_id);
				}
				res.render('applications/step_create_roles', { application: { id: req.application.id, 
																		      roles: roles, 
																		      permissions: permissions,
																		      role_permission_assign: role_permission_assign }});
			}).catch(function(error) { next(error); });
		}).catch(function(error) { next(error); });
	}).catch(function(error) { next(error); });
};

// GET /idm/applications/:applicationId/edit -- View to edit application
exports.edit = function(req, res) {
  res.render('applications/edit', { application: req.application, errors: []});
};

// PUT /idm/applications/:applicationId/edit/avatar -- Update application avatar
exports.update_avatar = function(req, res) {

	// See if the user has selected a image to upload
	if (req.file) {

		req.body.application = JSON.parse(JSON.stringify(req.application))
		req.body.application['image'] = req.file.filename

		// Check the MIME of the file upload
		var types = ['jpg', 'jpeg', 'png']
		magic.detectFile('public/img/applications/'+req.file.filename, function(err, result) {

			if (types.includes(String(result.split('/')[1]))) {
				// If the file is jpg, png or jpeg, update the application with the name of the image

				req.body.application["id"] = req.application.id
				var application = models.oauth_client.build(req.body.application);

					models.oauth_client.update(
						{ image: req.body.application.image },
						{
							fields: ['image'],
							where: {id: req.application.id}
						}
					).then(function() {
						// Send message of success when updating image 
						req.session.message = {text: ' Application updated successfully.', type: 'success'};
						res.redirect('/idm/applications/'+req.application.id);
					}).catch(function(error){ 
						// Send message of fail when updating image
						res.locals.message = {text: ' Application update failed.', type: 'warning'};
					 	res.render('applications/edit', { application: req.body.application, errors: error.errors});
					});	
			// If not, the default image is assigned to the application
			} else {
				fs.unlink('./public/img/applications/'+req.file.filename, (err) => {
					req.session.message = {text: ' Inavalid file.', type: 'danger'};
					res.redirect('/idm/applications/'+req.application.id);            
				});
			}
	  	});

	// If not redirect to show application info
  	} else {
  		req.session.message = {text: ' fail updating image.', type: 'warning'};
		res.redirect('/idm/applications/'+req.application.id);
  	} 
};

// PUT /idm/applications/:applicationId/edit/info -- Update application information
exports.update_info = function(req, res) {

	// If body has parameters id or secret don't update the application
	if (req.body.id || req.body.secret) {
		res.locals.message = {text: ' Application edit failed.', type: 'danger'};
		res.redirect('/idm/applications/'+req.application.id)
	} else {

		// Build a row and validate if input values are correct (not empty) before saving values in oauth_client table
		req.body.application["id"] = req.application.id;
		var application = models.oauth_client.build(req.body.application);

		application.validate().then(function(err) {
			models.oauth_client.update(
				{ name: req.body.application.name,
				  description: req.body.application.description,
				  url: req.body.application.url,
				  redirect_uri: req.body.application.redirect_uri },
				{
					fields: ['name','description','url','redirect_uri'],
					where: {id: req.application.id}
				}
			).then(function() {
				// Send message of success of updating the application
				req.session.message = {text: ' Application updated successfully.', type: 'success'};
				res.redirect('/idm/applications/'+req.application.id);
			});	
		}).catch(function(error){
			// Send message of warning of updating the application
			res.locals.message = {text: ' Application update failed.', type: 'warning'};
		 	res.render('applications/edit', { application: req.body.application, errors: error.errors});
		});
	}
};

// GET /idm/applications/:applicationId/edit/roles -- Show roles and permissions
exports.manage_roles = function(req, res, next) {

	// Search roles of application and order them
	models.role.findAll({
		where: { [Op.or]: [{oauth_client_id: req.application.id}, {is_internal: true}] },
		attributes: ['id', 'name'],
		order: [['id', 'DESC']]
	}).then(function(roles) {
		// Search permissions of application and order them
		models.permission.findAll({
			where: { [Op.or]: [{oauth_client_id: req.application.id}, {is_internal: true}] },
			attributes: ['id', 'name'], 
			order: [['id', 'ASC']]
		}).then(function(permissions) {
			// Search roles to permission assignment of application using id of roles
			models.role_permission.findAll({
				where: { role_id: roles.map(elem => elem.id) }						
			}).then(function(application_roles_permissions) {
					// Create and object with key as id of role and value an array of permissions id
					role_permission_assign = {}
					for (var i = 0; i < application_roles_permissions.length; i++) {
						if (!role_permission_assign[application_roles_permissions[i].role_id]) {
					        role_permission_assign[application_roles_permissions[i].role_id] = [];
					    }
					    role_permission_assign[application_roles_permissions[i].role_id].push(application_roles_permissions[i].permission_id);
					}
					res.render('applications/manage_roles', { application: { id: req.application.id, 
																			 roles: roles, 
																			 permissions: permissions,
																			 role_permission_assign: role_permission_assign }});
			}).catch(function(error) { next(error); });
		}).catch(function(error) { next(error); });
	}).catch(function(error) { next(error); });

}

// POST /idm/applications/:applicationId/edit/roles/create -- Create new role
exports.create_role = function(req, res) {

	// If body has parameters id or is_internal don't create the role
	if (req.body.id || req.body.is_internal) {
		res.send({text: ' Failed creating role', type: 'danger'});
	} else {

		// Build a row and validate if input values are correct (not empty) before saving values in role table
		var role = models.role.build({ name: req.body.name, 
								   oauth_client_id: req.application.id });

		role.validate().then(function(err) {
			role.save({fields: ["id", "name", "oauth_client_id"]}).then(function() {
				// Send message of success of creating role
				var message = {text: ' Create role', type: 'success'}
				res.send({role: role, message: message});
			})
		}).catch(function(error) {
			// Send message of fail when creating role
			res.send({text: error.errors[0].message, type: 'warning'});			
		});
	}
}

// PUT /idm/applications/:applicationId/edit/roles/:roleId/edit -- Edit a role
exports.edit_role = function(req, res) {
	var role_name = req.body.role_name;
	var role_id = req.body.role_id;

	// If body has parameter is_internal or role_id is provider or purchaser don't edit the role
	if (['provider', 'purchaser'].includes(role_id) || req.body.is_internal) {
		res.send({text: ' Failed editing role', type: 'danger'});
	
	} else {

		// Build a row and validate if input values are correct (not empty) before saving values in role table
		var role = models.role.build({ name: role_name, 
									   oauth_client_id: req.application.id });

		role.validate().then(function(err) {
			models.role.update(
				{ name: role_name },
				{
					fields: ["name"],
					where: {id: role_id}
				}
			).then(function(){
				// Send message of success of updating role
				res.send({text: ' Role was successfully edited.', type: 'success'});
			}).catch(function(error) {
				// Send message of fail when creating role
				res.send({text: ' Failed editing role.', type: 'danger'})
			});
		}).catch(function(error) {
			// Send message of fail when creating role (empty inputs)
			res.send({text: error.errors[0].message, type: 'warning'})
		});
	}
}

// DELETE /idm/applications/:applicationId/edit/roles/:roleId/delete -- Delete a role
exports.delete_role = function(req, res) {

	// If body has parameter is_internal or role_id is provider or purchaser don't delete the role
	if (['provider', 'purchaser'].includes(req.body.role_id) || req.body.is_internal) {
		res.send({text: ' Failed deleting role', type: 'danger'});
	
	} else {

		// Destroy role if body has role_id
		if (req.body.role_id) {
			models.role.destroy({
				where: { id: req.body.role_id,
						 oauth_client_id: req.application.id }
			}).then(function() {
				// Send message of success of deleting role
				res.send({text: ' Role was successfully deleted.', type: 'success'});
			}).catch(function(error) {
				// Send message of fail when deleting role
				res.send({text: ' Failed deleting role', type: 'danger'});
			});	
		} else {
			// Send message of fail when deleting role
			res.send({text: ' Failed deleting role', type: 'danger'});
		}
	}
}

// POST /idm/applications/:applicationId/edit/permissions/create -- Create new permission
exports.create_permission = function(req, res) {

	// If body has parameters id or is_internal don't create the permission
	if (req.body.id || req.body.is_internal) {
		res.send({text: ' Failed creating permission', type: 'danger'});
	} else {
		// Build a row and validate if input values are correct (not empty) before saving values in permission table
		var permission = models.permission.build({ name: req.body.name,
											 	   description: req.body.description,
											 	   action: req.body.action,
											 	   resource: req.body.resource,
											 	   xml: req.body.xml, 
											 	   oauth_client_id: req.application.id });

		permission.validate().then(function(err) {
			permission.save({fields: [ "id", 
									   "name", 
									   "description", 
									   "action", 
									   "resource", 
									   "xml", 
									   "oauth_client_id" ]
			}).then(function() {
				// Send message of success of creating role
				var message = {text: ' Create permission', type: 'success'}
				res.send({permission: permission, message: message});
			})
		}).catch(function(error) {
			// Send message of fail when creating role
			res.send({text: error.errors, type: 'warning'});
		});
	}
}

// POST /idm/applications/:applicationId/edit/roles -- Assing permissions to roles 
exports.role_permissions_assign = function(req, res) {
	
	var roles_id = Object.keys(JSON.parse(req.body.submit_assignment))
	// Filter req.body and obtain an array without roles provider and purchaser
	var public_roles_id = roles_id.filter(elem => !['provider','purchaser'].includes(elem))

	// If the array has elements destroy rows indicated on the array and create new ones
	if (public_roles_id.length > 0) {
		models.role_permission.destroy({
			where: { 
				role_id: public_roles_id
			}
		}).then(function() {
			var submit_assignment = JSON.parse(req.body.submit_assignment);
			// Array of objects with role_id, permission_id and oauth_client_id
			create_assign_roles_permissions = []
			for(var role in submit_assignment) {
				if (!['provider', 'purchaser'].includes(role)) {
					for (var permission = 0; permission < submit_assignment[role].length; permission++) {
						create_assign_roles_permissions.push({	role_id: role, 
																permission_id: submit_assignment[role][permission], 
																oauth_client_id: req.application.id })
					}
				}
			}

			// Inset values into role_permission table
			models.role_permission.bulkCreate(create_assign_roles_permissions).then(function() {
				// Send message of success of assign permissions to roles
				req.session.message = {text: ' Modified roles and permissions.', type: 'success'};
				res.redirect("/idm/applications/"+req.application.id)
			}).catch(function(error) {
				// Send message of fail in assign permissions to roles
				req.session.message = {text: ' Roles and permissions assignment error.', type: 'warning'};
				res.redirect("/idm/applications/"+req.application.id)
			});
		}).catch(function(error) {
			// Send message of fail in assign permissions to roles
			req.session.message = {text: ' Roles and permissions assignment error.', type: 'warning'};
			res.redirect("/idm/applications/"+req.application.id)
		});
	} else {
		// Redirect to show application if there is no changes
		res.redirect("/idm/applications/"+req.application.id)
	}
}

// DELETE /idm/applications/:applicationId/edit/delete_avatar -- Delete avatar
exports.delete_avatar = function(req, res) {

	// Don't don anything if images is the default one
	if (!req.body.image_name.includes('/img/applications')) {
		res.send({text: ' Cannot delete default image.', type: 'danger'});
	} else {

		// Change image to default one in oauth_client table
		models.oauth_client.update(
			{ image: 'default' },
			{
				fields: ["image"],
				where: {id: req.application.id }
			}
		).then(function(){
			// Delete image from filesystem
			var image_name = req.body.image_name.split('/')[3]
			fs.unlink('./public/img/applications/'+image_name, (err) => {
		        if (err) {
		        	// Send message of fail when deleting image
		            res.send({text: ' Failed to delete image.', type: 'warning'});
		        } else {
		        	// Send message of success in deleting image
		        	req.application.image = '/img/logos/original/app.png'
		            res.send({text: ' Deleted image.', type: 'success'});                               
		        }
			});
		}).catch(function(error) {
			// Send message of fail when deleting image
			res.send({text: ' Failed to delete image.', type: 'warning'});
		});
	}
};

// DELETE /idm/applications/:applicationId -- Delete application
exports.destroy = function(req, res) {
	// Destroy application with specific id
	models.oauth_client.destroy({
		where: { id: req.application.id }
	}).then(function() {
		// If the image is not the default one, delete image from filesystem
		if (req.application.image.includes('/img/applications')) {
			var image_name = req.application.image.split('/')[3]
			fs.unlink('./public/img/applications/'+image_name);
		}
		// Send message of success in deleting application
		req.session.message = {text: ' Application deleted.', type: 'success'};
		res.redirect('/idm/applications')
	}).catch(function(error) {
		// Send message of fail when deleting application
		req.session.message = {text: ' Application delete error.', type: 'warning'};
		res.redirect('/idm/applications');
	});
};

// GET /idm/applications/:applicationId/edit/users -- Search users authorized
exports.get_users = function(req, res, next) {

	// See if the request is via AJAX or browser
	if (req.xhr) {

		// Search info about the users authorized in the application
		models.role_user.findAll({
			where: { oauth_client_id: req.application.id },
			include: [{
				model: models.user,
				attributes: ['id', 'username']
			}]
		}).then(function(users_application) {

			// Array of users authorized in the application
			var users_authorized = []
			// Array of roles owned by the user logged
			var user_logged_roles = []

			users_application.forEach(function(app) {
				if(app.User.id === req.session.user.id) {
					user_logged_roles.push(app.role_id)
				}
				users_authorized.push({ user_id: app.User.id, 
										role_id: app.role_id, 
										username: app.User.username, 
										added: 1 }); // Added parameter is to control which elements will be deleted or added 
													 // to the table when authorizing other users
			});

			// Search permissions using the roles of the user logged
			models.role_permission.findAll({
				where: { role_id: user_logged_roles },
				attributes: ['permission_id'],
			}).then(function(user_logged_permissions) {
				if(user_logged_permissions.length > 0) {
					user_logged_permissions_id = user_logged_permissions.map(elem => elem.permission_id)
					// Array to indicate which roles are going to be search
					var where_search_role = []

					// If permission is assign only public owned roles
					if (user_logged_permissions_id.includes('6')) {
						where_search_role.push({id: user_logged_roles});
					}

					// If permission is assign all public owned roles
					if (user_logged_permissions_id.includes('5')) {
						where_search_role.push({oauth_client_id: req.application.id})
					}

					// If permission is assign only internal roles
					if (user_logged_permissions_id.includes('1')) {
						where_search_role.push({is_internal: true});
					}

					// Search roles to display when authorize users
					models.role.findAll({
						where: { [Op.or]: where_search_role },
						attributes: ['id', 'name'],
						order: [['id', 'DESC']]
					}).then(function(roles) {
						// Filter users_authorized depends on the permissions of the user logged
						for (var i = 0; i < users_authorized.length; i++) {
							if (roles.some(role => role.id === users_authorized[i].role_id) === false) {
								users_authorized[i].role_id = ""
							}
						}

						if (roles) {
							// Sen info about roles, users authorized and application
							res.send({ application: req.application, 
									   users_authorized: users_authorized, 
									   roles: roles,
									   errors: [] });
						} else { res.send('error') }
					}).catch(function(error) { next(error); });
				} else { res.send('error') }
			}).catch(function(error) { next(error); });
		}).catch(function(error) { next(error); });
	} else {
		// Redirect to show application if the request is via browser
		res.redirect('/idm/applications/'+req.application.id)
	}
}


// POST /idm/applications/:applicationId/users/available -- Search users to authorize in an application
exports.available_users = function(req, res) {

	// Obtain key to search in the user table
	var key = req.body.username

	// Search if username is like the input key
	models.user.findAll({
	 	attributes: ['username', 'id'],
		where: {
            username: {
                like: '%' + key + '%'
            }
        }
	}).then(function(users) {
		// If found, send ana array of users with the username and the id of each one
		if (users.length > 0) {
			res.send(users)
		} else {
			// If the result is null send an error message
			res.send('no_users_found')
		}
	});

}

// POST /idm/applications/:applicationId/edit/users -- Authorize users in an application
exports.authorize_users = function(req, res, next) {
	console.log(req.body.submit_authorize)
	// Parse de body and filter to delete the rows with no role assigned to the user
	var users_to_be_authorized = JSON.parse(req.body.submit_authorize)

	users_to_be_authorized = users_to_be_authorized.filter(function(elem) {
    	return (elem.role_id !== "")
    });

	// If the array is not empty change values in role_user table 
	if (users_to_be_authorized.length > 0) {

		// Search for actual values of role assignment to users
		models.role_user.findAll({
			where: { oauth_client_id: req.application.id },
			attributes: ['role_id', 'user_id', 'oauth_client_id']
		}).then(function(users_application_actual) {
			if (users_application_actual.length > 0) {

				// See differences between actual assignment and the data received from client
				var new_authorization_users = authorize_all(users_application_actual, users_to_be_authorized, req.application)

				// Destroy users that now are not authorized now
				for(var i = 0; i < new_authorization_users.delete_row.length; i++) {
					models.role_user.destroy({
						where: new_authorization_users.delete_row[i]
					})
				}

				models.role_user.bulkCreate(new_authorization_users.add_row).then(function() {
					// Send message of success in updating authorizations
					req.session.message = {text: ' Modified users authorization.', type: 'success'};
					res.redirect('/idm/applications/'+req.application.id)
				}).catch(function(error) {
					// Send message of fail when updating authorizations
					req.session.message = {text: ' Modified users authorization error.', type: 'warning'};
					res.redirect('/idm/applications/'+req.application.id)
				});

			} else { next(new Error("The applications hasn't got users authorized"));}
		}).catch(function(error) { next(error); });
	} else {
		req.session.message = {text: ' Application must have a user authorized.', type: 'danger'};
		res.redirect('/idm/applications/'+req.application.id)
	}
}

// GET /idm/applications/:applicationId/iot/register -- Register IoT sensor
exports.register_iot = function(req, res, next) {
	// Id and password of the sensor
	var id = 'iot_sensor_'+uuid.v4()
	var password = 'iot_sensor_'+uuid.v4()

	// Build a new row in the iot table
	var iot = models.iot.build({id: id, password: password, oauth_client_id: req.application.id});
	iot.save({fields: ['id','password','oauth_client_id']}).then(function() {
		// Send message of success in create an iot sensor
		req.session.message = {text: ' Create IoT sensor.', type: 'success'};
		res.redirect('/idm/applications/'+req.application.id)
	}).catch(function(error) {
		// Send message of fail when create an iot sensor
		req.session.message = {text: ' Failed create IoT sensor.', type: 'warning'};
		res.redirect('/idm/applications/'+req.application.id)
	});
}

// GET /idm/applications/:applicationId/pep/register -- Register Pep Proxy
exports.register_pep = function(req, res, next) {

	// See if the application has already assigned a pep proxy
	models.pep_proxy.findOne({
		where: { oauth_client_id: req.application.id }
	}).then(function(pep_proxy) {
		// If not create it
		if(!pep_proxy) {

			// Id and password of the proxy
			var id = 'pep_proxy_'+uuid.v4()
			var password = 'pep_proxy_'+uuid.v4()

			// Build a new row in the pep_proxy table
			var pep_proxy = models.pep_proxy.build({id: id, password: password, oauth_client_id: req.application.id});
			pep_proxy.save({fields: ['id','password','oauth_client_id']}).then(function() {
				// Send message of success in create a pep proxy
				req.session.message = {text: ' Create Pep Proxy.', type: 'success'};
				res.redirect('/idm/applications/'+req.application.id)
			}).catch(function(error) {
				// Send message of fail when create a pep proxy
				req.session.message = {text: ' Failed create Pep Proxy.', type: 'warning'};
				res.redirect('/idm/applications/'+req.application.id)
			});
		} else {
			req.session.message = {text: ' Pep Proxy already created.', type: 'warning'};
			res.redirect('/idm/applications/'+req.application.id)
		}
	}).catch(function(error) { next(error); });
}


// Method to see users permissions to do some actions
// - 1 Get and assign all internal application roles
// - 2 Manage the application
// - 3 Manage roles
// - 4 Manage authorizations
// - 5 Get and assign all public application roles
// - 6 Get and assign only public owned roles
function check_user_action(application, path, method, permissions) {
	switch(true) {
		case (path.includes('step/avatar')):
			if (permissions.includes('2')) {
				return true;
			}
	        break;
	    case (path.includes('step/roles') || path.includes('edit/roles') || path.includes('edit/permissions')):
	        if (permissions.includes('3')) {
				return true;
			}
	        break;
	    case (path.includes('edit/users')):
	    	if (permissions.some(r=> ['1','5','6'].includes(r))) {
	    		return true;
	    	}
	        break;    
	    case (path.includes('edit') || path.includes('iot') || path.includes('pep')):
	        if (permissions.includes('2')) {
				return true;
			}
	        break;
	    case (path.includes(application.id) && method === 'DELETE'):
	        if (permissions.includes('2')) {
				return true;
			}
	        break;
	    default:
	        return false;
	}
}

// Method to see how add new rows to role_user database
function authorize_all(actual, change, application) {

	// Array with rows to delete
	var delete_row = []

	// Array with rows to add
	var add_row = []
	for (var i = 0; i < change.length; i++) {
		// If has change the actual roles, add row to delete_row array
		if(change[i].added === 0) {
			delete_row.push({user_id: change[i].user_id, role_id: change[i].role_id, oauth_client_id: application.id})
		// If not, see if the table contains the row. If not add to add_row array
		} else if (change[i].added === 1) {
			if(actual.some(elem => (elem.user_id === change[i].user_id && elem.role_id === change[i].role_id)) === false) {
				add_row.push({user_id: change[i].user_id, role_id: change[i].role_id, oauth_client_id: application.id})
			}
		}
	}

	return { delete_row: delete_row,
			 add_row: add_row }
}

// Function to delete duplicates entries
function delete_duplicates(arr) {
  return arr.reduce(function (p, c) {
    var key = [c.user_id, c.role_id].join('|');
    if (p.temp.indexOf(key) === -1) {
      p.out.push(c);
      p.temp.push(key);
    }
    return p;
  }, { temp: [], out: [] }).out;
}
