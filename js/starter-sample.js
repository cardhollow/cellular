"use strict";

const STARTER_SAMPLE = `# CELLULAR PROGRAMMING LANGUAGE - starter program #
@grid 8 6

# Chain 1: mark a diagonal. Each ':' advances to the next code position. #
set(0,0,1):set(1,1,1):set(2,2,1):set(3,3,1);

# Chain 2: this condition is true, so the next position runs. #
if(2,2,1):set(6,1,1);

# Chain 3: jmp(2) skips one code position and moves two positions right. #
set(0,5,1):jmp(2):set(2,5,1):set(4,5,1);

# Chain 4: this false condition ends only this chain. Chain 5 still runs. #
if(7,5,1):set(7,4,1);

# Chain 5: fill an inclusive rectangular region in one command. #
fill(4,0,5,1,1);

# Chain 6: copy a 3 × 3 area to a new location in one command. #
copy(0,0,2,2,5,3);

# Chain 7: the root CB instances are independent and scheduled in turns. #
set(7,0,1);
`;
