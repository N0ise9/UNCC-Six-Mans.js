# Getting Up and Running with NormJS

## Install NodeJS

Discord.js requires Node 18.18.0 or newer. Go to [nodejs.org](https://nodejs.org/en/), download and install NodeJS 18.18.0 or newer. Be sure to include NPM and adding Node to your PATH during installation.

- NPM stands for Node Package Manager and is a command-line tool for managing dependencies of projects.
- You can verify node is installed by opening a terminal and typing `node --version`. Verify the version matches the requirements above.

## Installing Dependencies

Once Node and NPM are installed, open a terminal and navigate to the root of this project. Run the command `npm install`. This will install all of the dependencies needed for running the project.

- To see a list of the dependencies for this project open the `package.json` in the root of this project. You'll notice two sections called `dependencies` and `devDependencies`. Dependencies are the packages that will be included when building the app for production. Dev dependencies are only used during development. This helps keep the bundle size small when deploying to production.
- You'll notice that a new folder is automatically added called `node_modules`. This folder holds the source for all of the project's dependencies. This folder should not be committed to source control.

## Running the Code

### Discord Token
Discord bots require a token to authenticate with the Discord API. The token should **never** be put into source control. Create a file named `.env` in the root of the project. In this new file add `token=[Discord token]` where `[Discord token]` is the token for your bot.

### Local Database
This project uses [Prisma](https://www.prisma.io) with a [PostgreSQL](https://www.postgresql.org/) database to store all of the necessary data to operate six mans. You will need [Docker](https://www.docker.com/) installed on your machine. You can go [here](https://docs.docker.com/get-docker/) to download the latest version of Docker. Once you have Docker installed run the following command in a terminal/Powershell window:
```
docker run --name uncc_six_mans -p 5432:5432 -e POSTGRES_USER=Norm  -e POSTGRES_PASSWORD=NormTheNiner -d postgres
```
This starts a new container using the [latest PostgreSQL image from Docker Hub](https://hub.docker.com/_/postgres) with the name "uncc_six_mans." In your local `.env` file. Add the following entry:
```
DATABASE_URL="postgresql://Norm:NormTheNiner@localhost:5432/SixMans"
```
This is the connection string that Prisma will use to connect to the database. Next run `npx prisma db push`. This command compiles the Prisma schema, pushes it to the Postgre DB, and generates the types for development.

To stop the container, run the command: `docker container stop uncc_six_mans`.

To start the container, run the command: `docker container start uncc_six_mans`.

Prisma also offers a tool for viewing the data in the database called Prisma Studio. To start it, run the command: `npx prisma studio`. This will output a localhost URL that you can paste into your browser and explore the database.

### Start Norm
Now that our dependencies are installed, our token is set, and our database is running we can run the code. Type `npm start` to start the bot. To stop the bot hit `CTRL + C` in the running terminal.


## Linting and Formatting
This project uses ESLint and Prettier to enforce code standards and consistency. To check to see if there are any issues run the command `npm run lint`. If the report concludes without any errors or warnings then there are no issues. Otherwise, it will include the error and file name to check.

## Tests

This project uses [Jest](https://jestjs.io/) and [ts-jest](https://www.npmjs.com/package/ts-jest) for writing and running tests. Test files are denoted by files with the `.spec.ts` extension. 

### Unit tests
To run unit tests use the command `npm run test`. This will run every unit test file found in the project. To run tests for a specific file use the command `npm run test [file name]`.

### Integration tests
To run integration tests make sure the Postgres container is running and use the command `npm run integration`. This will run every integration test file found in the project. To run tests for a specific file use the command `npm run integration [file name]`.
